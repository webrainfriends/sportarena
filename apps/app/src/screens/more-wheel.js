import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, PanResponder, Platform, Pressable, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Avatar, T } from '../ui';
import { Glass } from '../glass';
import { c, dark, day, locale } from '../theme';
import { TileArt, tileColors } from './more-art';
import { GROUP_COLOR, orderedModules } from './more-catalog';

const STEP = 20;        // degrees between neighbouring modules on the wheel
const VISIBLE = 78;     // modules beyond this angle from the centre are hidden
const PX_PER_STEP = 60; // vertical drag needed to turn the wheel by one module

const wrap = (rel, n) => ((rel + n / 2) % n + n) % n - n / 2; // signed distance on a ring of n

/**
 * The More experience: tapping the raised centre tab button opens this full-screen wheel. Your profile sits in a big
 * circle on the left; every module is on a wheel you drag (or scroll / arrow-key) to swivel. The module at the centre
 * is enlarged; tapping it opens it. Counts come from real data and are shown on the modules themselves.
 */
export function GlassWheel({ variant = 'layer', onDragState }) {
  const layer = variant === 'layer';
  const { push, goTab, closeMenu } = useNav();
  const { user } = useSession();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const dash = useLoad(() => api.get('/dashboard'), []);
  const note = useLoad(() => api.get('/notifications', { unread: true, limit: 1 }), []);
  const d = dash.data, unread = note.data?.unread ?? 0;
  const next = d?.next_games?.[0];
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

  const drag = useRef(onDragState);
  drag.current = onDragState;
  const vertical = (_, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx);
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: vertical,
    onMoveShouldSetPanResponderCapture: vertical,      // wins over a parent ScrollView (Home) once the drag is vertical
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { drag.current?.(true); rot.stopAnimation((v) => { base.current = v; }); },
    onPanResponderMove: (_, g) => rot.setValue(base.current - g.dy / PX_PER_STEP),
    onPanResponderRelease: (_, g) => { drag.current?.(false); spinTo(Math.round(base.current - g.dy / PX_PER_STEP - g.vy * 0.25), -g.vy / PX_PER_STEP * 1000); },
    onPanResponderTerminate: () => { drag.current?.(false); spinTo(Math.round(cur.current)); },
  }), [rot, spinTo]);

  // Web: mouse wheel and arrow keys turn the wheel (the layer also closes on Escape).
  const wheelLock = useRef(0);
  const onWheel = useCallback((e) => { const t = Date.now(); if (t - wheelLock.current < 120) return; wheelLock.current = t; nudge(e.deltaY > 0 ? 1 : -1); }, [nudge]);
  useEffect(() => {
    if (Platform.OS !== 'web' || !layer) return undefined;
    const onKey = (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); nudge(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(-1); } else if (e.key === 'Escape') closeMenu(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nudge, closeMenu, layer]);

  const { w, h } = size;
  const R = Math.min(layer ? (w > 700 ? 175 : 132) : 108, w * (layer ? 0.3 : 0.26), h * (layer ? 0.3 : 0.28)), cx = R * 0.42, cy = h * 0.5, R2 = R + (layer ? 56 : 50);
  const vis = layer ? VISIBLE : 72;
  const centred = ((Math.round(pos) % n) + n) % n;
  const now = new Date();
  const dateLine = now.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const statLine = [d?.points > 0 && `${d.points} points`, d?.trophies > 0 && `${d.trophies} trophies`].filter(Boolean).join(' · ');
  const scrim = dark ? 'rgba(5,31,32,0.14)' : 'rgba(237,247,239,0.16)'; // just enough to settle the profile circle; the screen stays fully visible
  const web = Platform.OS === 'web';

  const content = w ? (
    <>
      <View pointerEvents="none" style={{ position: 'absolute', left: cx - R - 18, top: cy - R - 18, width: R * 2 + 36, height: R * 2 + 36, borderRadius: R + 18, borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)' }} />
      <View pointerEvents="none" style={{ position: 'absolute', left: cx - R2, top: cy - R2, width: R2 * 2, height: R2 * 2, borderRadius: R2, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' }} />

      <Pressable onPress={() => goTab('Me')} accessibilityRole="button" accessibilityLabel={`${user.display_name}. My profile, roles and settings`} style={{ position: 'absolute', left: cx - R, top: cy - R, width: R * 2, height: R * 2 }}>
        <Glass radius={R} preset="clear" gloss iris style={{ width: R * 2, height: R * 2 }}>
          <View style={{ position: 'absolute', left: R - cx + 10, right: 8, top: 0, bottom: 0, justifyContent: 'center' }}>
            <Glass radius={18} preset="soft" gloss style={{ paddingVertical: 10, paddingHorizontal: 12, alignSelf: 'flex-start', maxWidth: '100%' }}>
            {layer ? (
              <>
                <View style={{ marginBottom: 8 }}><Avatar user={user} size={40} /></View>
                <T weight="800" size={20} color={c.ink} numberOfLines={1} style={{ letterSpacing: -0.4 }}>{user.display_name}</T>
                <T weight="500" size={12} color={c.mute} numberOfLines={1}>{dateLine}</T>
                {statLine ? <T weight="700" size={13} color={c.pink} numberOfLines={1} style={{ marginTop: 2 }}>{statLine}</T> : null}
                {next ? <T weight="500" size={12} color={c.mute} numberOfLines={1} style={{ marginTop: 2 }}>{`Next: ${next.home_name ?? 'TBC'} vs ${next.away_name ?? 'TBC'} · ${day(next.scheduled_at)}`}</T> : null}
              </>
            ) : (
              <>
                <T weight="700" size={11} color={c.mute} numberOfLines={1} style={{ letterSpacing: 0.4 }}>{now.toLocaleDateString(locale, { weekday: 'long' }).toUpperCase()}</T>
                <T weight="800" size={48} color={c.ink} style={{ letterSpacing: -2, lineHeight: 52 }}>{now.getDate()}</T>
                <T weight="600" size={12} color={c.mute} numberOfLines={1}>{now.toLocaleDateString(locale, { month: 'long' })}</T>
                {statLine ? <T weight="700" size={12} color={c.pink} numberOfLines={2} style={{ marginTop: 4 }}>{statLine.replace(' · ', '\n')}</T> : null}
              </>
            )}
            </Glass>
          </View>
        </Glass>
      </Pressable>

      {mods.map(([name, title, sub, group], i) => {
        const rel = wrap(i - pos, n), a = rel * STEP;
        if (Math.abs(a) > vis) return null;
        const rad = (a * Math.PI) / 180;
        const near = Math.max(0, 1 - Math.abs(rel));       // 1 at the centre, 0 one module away
        const k = 1 - 0.38 * (Math.abs(a) / vis);          // shrink toward the arc ends
        const D = 54 * k + 22 * near;
        const x = cx + R2 * Math.cos(rad), y = cy + R2 * Math.sin(rad);
        const [from, to] = tileColors(name);
        const badge = name === 'Notifications' ? unread : badges[name];
        const isCentre = i === centred && Math.abs(rel) < 0.5;
        return (
          <Pressable key={name} onPress={() => (isCentre ? push(name) : spinTo(Math.round(pos) + Math.round(rel)))} accessibilityRole="button"
            accessibilityLabel={`${title}${badge > 0 ? `, ${badge} need attention` : ''}${isCentre ? ', selected. Tap to open' : ''}`}
            style={{ position: 'absolute', left: x - D / 2, top: y - D / 2, flexDirection: 'row', alignItems: 'center', opacity: 1 - 0.55 * (Math.abs(a) / vis), zIndex: Math.round(100 - Math.abs(a)) }}>
            <Glass radius={D / 2} preset="clear" gloss iris style={{ width: D, height: D, ...(web ? { boxShadow: `0 ${4 + near * 8}px ${14 + near * 22}px ${from}${isCentre ? '99' : '44'}, inset 1.5px 1.5px 0 rgba(255,255,255,0.8), inset -1px -1px 0 rgba(255,255,255,0.3), inset 0 0 ${10 + near * 8}px rgba(255,255,255,0.2)` } : { shadowColor: from, shadowOpacity: 0.45, shadowRadius: 12 + near * 12, shadowOffset: { width: 0, height: 6 } }) }}>
              <LinearGradient colors={[`${from}A6`, `${to}A6`]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
                <TileArt name={name} size={D * 0.78} />
                <View pointerEvents="none" style={{ position: 'absolute', top: D * 0.06, left: D * 0.16, width: D * 0.68, height: D * 0.3, borderRadius: D, backgroundColor: 'rgba(255,255,255,0.26)' }} />
              </LinearGradient>
            </Glass>
            {badge > 0 ? <View style={{ position: 'absolute', left: D - 14, top: -6, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: c.red, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' }}><T weight="800" size={11} color="#fff">{badge}</T></View> : null}
            <Glass radius={999} preset="soft" gloss style={{ marginLeft: 10, paddingVertical: 5, paddingHorizontal: 10, maxWidth: Math.max(80, w - (x + D / 2) - 24) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: GROUP_COLOR[group] }} />
                <T weight={isCentre ? '800' : '700'} size={13 + near * 5} color={c.ink} numberOfLines={1} style={{ letterSpacing: 0.2, flexShrink: 1 }}>{title}</T>
              </View>
              {isCentre ? <T size={12} color={c.mute} numberOfLines={2} style={{ marginTop: 2 }}>{lives[name] ?? sub}</T> : null}
            </Glass>
          </Pressable>
        );
      })}

      {layer ? (
        <Pressable onPress={closeMenu} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" style={{ position: 'absolute', top: 14, right: 16 }}>
          <Glass radius={20} preset="soft" gloss style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}><T color={c.ink} weight="700" size={20}>×</T></Glass>
        </Pressable>
      ) : null}
      <View pointerEvents="none" style={{ position: 'absolute', right: 18, ...(layer ? { bottom: 16 } : { top: 12 }) }}>
        <Glass radius={999} preset="soft" gloss style={{ paddingVertical: 4, paddingHorizontal: 10 }}><T size={11} color={c.mute} weight="700" style={{ letterSpacing: 1 }}>DRAG TO SWIVEL</T></Glass>
      </View>
    </>
  ) : null;

  const handlers = { onLayout: (e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height }), ...pan.panHandlers, ...(web ? { onWheel } : {}) };
  if (layer) {
    return (
      <Animated.View {...handlers} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 20, opacity: fade, ...(web ? { touchAction: 'none' } : null) }}>
        <Pressable onPress={closeMenu} accessible={false} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
        <LinearGradient pointerEvents="none" colors={[scrim, 'rgba(0,0,0,0)']} start={{ x: 0, y: 0 }} end={{ x: 0.6, y: 0 }} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
        {content}
      </Animated.View>
    );
  }
  return (
    <Animated.View {...handlers} style={{ height: 340, opacity: fade, ...(web ? { touchAction: 'none' } : null) }}>
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 32, borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)' }} />
      <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderRadius: 32, overflow: 'hidden' }}>{content}</View>
    </Animated.View>
  );
}

/** More button: the glass wheel laid over whatever screen you are on. */
export const MoreWheel = () => <GlassWheel variant="layer" />;
