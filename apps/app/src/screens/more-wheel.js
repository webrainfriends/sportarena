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
import { roleLabel } from '../roles';
import { GROUP_COLOR, orderedModules, workspacesFor } from './more-catalog';

const STEP_ARC = 26;    // degrees between neighbouring modules on the arc
const ARC_VIS = 82;     // modules beyond this angle from straight up are hidden
const PX_PER_STEP = 56; // horizontal drag needed to turn the wheel by one module

const wrap = (rel, n) => ((rel + n / 2) % n + n) % n - n / 2; // signed distance on a ring of n

/**
 * The More experience: tapping the raised centre tab button lays a lightly frosted glass veil over the screen and fans the
 * modules out in an arc that rises from the More button (the pivot). Drag, scroll or arrow-key to swivel; the module at the
 * top of the arc is enlarged and named above it, and tapping it opens it. Counts come from real data and sit on the discs.
 */
export function MoreWheel() {
  const { push, goTab, closeMenu } = useNav();
  const { user, setActiveRole } = useSession();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const dash = useLoad(() => api.get('/dashboard'), []);
  const note = useLoad(() => api.get('/notifications', { unread: true, limit: 1 }), []);
  const d = dash.data, unread = note.data?.unread ?? 0;
  const next = d?.next_games?.[0];
  const mods = useMemo(() => orderedModules(user.roles), [user.roles]);
  const n = mods.length;
  const spaces = useMemo(() => workspacesFor(user.roles), [user.roles]);
  const [picker, setPicker] = useState(false); // the Workspace submenu: one row per role that has a workspace
  const openSpace = useCallback(([role, route, , tab]) => { setActiveRole(role); if (tab) goTab(tab.tab, { section: tab.section }); else push(route); }, [push, goTab, setActiveRole]);
  const open = useCallback((name) => {
    if (name !== 'Workspace') { push(name); return; }
    if (spaces.length === 1) openSpace(spaces[0]); else setPicker(true);
  }, [push, spaces, openSpace]);

  const badges = { Insure: d?.policies_to_renew, Insurance: d?.policies_to_renew, Leaderboard: d?.pending_results };
  const lives = {
    Leaderboard: d?.pending_results > 0 ? `${d.pending_results} result${d.pending_results > 1 ? 's' : ''} waiting for approval` : null,
    Insure: d?.policies_to_renew > 0 ? `${d.policies_to_renew} to renew soon` : null,
    Workspace: spaces.length > 1 ? `${spaces.length} workspaces · ${spaces.map(([r]) => roleLabel(r)).join(', ')}` : spaces[0] ? spaces[0][2] : null,
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

  // The swivel is an arc that rises from the More button (its pivot); a horizontal drag turns it.
  const horizontal = (_, g) => Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy);
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: horizontal,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { rot.stopAnimation((v) => { base.current = v; }); },
    onPanResponderMove: (_, g) => rot.setValue(base.current - g.dx / PX_PER_STEP),
    onPanResponderRelease: (_, g) => { spinTo(Math.round(base.current - g.dx / PX_PER_STEP - g.vx * 0.25), -g.vx / PX_PER_STEP * 1000); },
    onPanResponderTerminate: () => { spinTo(Math.round(cur.current)); },
  }), [rot, spinTo]);

  // Web: mouse wheel and arrow keys turn it (Escape closes).
  const wheelLock = useRef(0);
  const onWheel = useCallback((e) => { const t = Date.now(); if (t - wheelLock.current < 120) return; wheelLock.current = t; const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; nudge(d > 0 ? 1 : -1); }, [nudge]);
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const onKey = (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); nudge(1); } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); nudge(-1); } else if (e.key === 'Escape') closeMenu(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nudge, closeMenu]);

  const { w, h } = size;
  const BAR_C = 66;                                              // the More button's centre, measured up from the bottom of the area
  const cx = w / 2, cy = h - BAR_C;
  const R2 = Math.min(w * 0.4, h * 0.42, 210);
  const centred = ((Math.round(pos) % n) + n) % n;
  const now = new Date();
  const dateLine = now.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const statLine = [d?.points > 0 && `${d.points} points`, d?.trophies > 0 && `${d.trophies} trophies`].filter(Boolean).join(' · ');
  const web = Platform.OS === 'web';
  // Light frost: the page stays recognisable (shapes, colours) but its text is not legible; a bit stronger at the bottom, where the arc is.
  const veil = dark ? ['rgba(24,26,47,0.22)', 'rgba(24,26,47,0.46)'] : ['rgba(255,244,238,0.28)', 'rgba(255,244,238,0.54)'];

  const content = w ? (
    <>
      <View pointerEvents="none" style={{ position: 'absolute', left: cx - R2, top: cy - R2, width: R2 * 2, height: R2 * 2, borderRadius: R2, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' }} />
      <View pointerEvents="none" style={{ position: 'absolute', left: cx - R2 + 34, top: cy - R2 + 34, width: (R2 - 34) * 2, height: (R2 - 34) * 2, borderRadius: R2 - 34, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)' }} />

      <Pressable onPress={() => goTab('Me')} accessibilityRole="button" accessibilityLabel={`${user.display_name}. My profile, roles and settings`} style={{ position: 'absolute', top: 14, left: 16 }}>
        <Glass radius={999} preset="soft" gloss iris style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, paddingLeft: 6, paddingRight: 14 }}>
          <Avatar user={user} size={36} />
          <View>
            <T weight="800" size={14} color={c.ink} numberOfLines={1}>{user.display_name}</T>
            <T weight="500" size={11} color={c.mute} numberOfLines={1}>{[dateLine, statLine].filter(Boolean).join(' · ')}</T>
          </View>
        </Glass>
      </Pressable>

      {mods.map(([name, title, sub, group], i) => {
        const rel = wrap(i - pos, n), a = rel * STEP_ARC;
        if (Math.abs(a) > ARC_VIS) return null;
        const rad = (a * Math.PI) / 180;
        const near = Math.max(0, 1 - Math.abs(rel));
        const k = 1 - 0.3 * (Math.abs(a) / ARC_VIS);
        const D = 54 * k + 24 * near;
        const x = cx + R2 * Math.sin(rad), y = cy - R2 * Math.cos(rad);
        const [from, to] = tileColors(name);
        const badge = name === 'Notifications' ? unread : badges[name];
        const isCentre = i === centred && Math.abs(rel) < 0.5;
        return (
          <Pressable key={name} onPress={() => (isCentre ? open(name) : spinTo(Math.round(pos) + Math.round(rel)))} accessibilityRole="button"
            accessibilityLabel={`${title}${badge > 0 ? `, ${badge} need attention` : ''}${isCentre ? ', selected. Tap to open' : ''}`}
            style={{ position: 'absolute', left: x - D / 2, top: y - D / 2, width: D, height: D, opacity: 1 - 0.45 * (Math.abs(a) / ARC_VIS), zIndex: Math.round(100 - Math.abs(a)) }}>
            <Glass radius={D / 2} preset="clear" gloss iris style={{ width: D, height: D, ...(web ? { boxShadow: `0 ${4 + near * 8}px ${14 + near * 22}px ${from}${isCentre ? '99' : '44'}, inset 1.5px 1.5px 0 rgba(255,255,255,0.8), inset -1px -1px 0 rgba(255,255,255,0.3), inset 0 0 ${10 + near * 8}px rgba(255,255,255,0.2)` } : { shadowColor: from, shadowOpacity: 0.45, shadowRadius: 12 + near * 12, shadowOffset: { width: 0, height: 6 } }) }}>
              <LinearGradient colors={[`${from}A6`, `${to}A6`]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
                <TileArt name={name} size={D * 0.78} />
                <View pointerEvents="none" style={{ position: 'absolute', top: D * 0.06, left: D * 0.16, width: D * 0.68, height: D * 0.3, borderRadius: D, backgroundColor: 'rgba(255,255,255,0.26)' }} />
              </LinearGradient>
            </Glass>
            {badge > 0 ? <View style={{ position: 'absolute', right: -4, top: -4, minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5, backgroundColor: c.red, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#fff' }}><T weight="800" size={11} color="#fff">{badge}</T></View> : null}
          </Pressable>
        );
      })}

      {/* the centred module's name sits above the arc, so labels never fight the page for space */}
      {mods[centred] ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: Math.max(64, cy - R2 - 96), alignItems: 'center' }}>
          <Glass radius={22} preset="soft" gloss style={{ paddingVertical: 8, paddingHorizontal: 18, alignItems: 'center', maxWidth: w - 32 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: GROUP_COLOR[mods[centred][3]] }} />
              <T weight="800" size={20} color={c.ink} numberOfLines={1} style={{ letterSpacing: -0.2 }}>{mods[centred][1]}</T>
            </View>
            <T size={12} color={c.mute} numberOfLines={1} style={{ marginTop: 2 }}>{lives[mods[centred][0]] ?? mods[centred][2]}</T>
          </Glass>
        </View>
      ) : null}

      {picker ? (
        <>
          <Pressable onPress={() => setPicker(false)} accessible={false} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 200 }} />
          <View accessibilityViewIsModal style={{ position: 'absolute', left: 16, right: 16, bottom: BAR_C + 28, alignItems: 'center', zIndex: 201 }}>
            <Glass radius={26} preset="soft" gloss style={{ padding: 14, width: '100%', maxWidth: 420, gap: 8 }}>
              <T weight="800" size={16} color={c.ink}>Open a workspace</T>
              <T size={12} color={c.mute}>You hold more than one role. Pick the workspace you want.</T>
              {spaces.map((sp) => (
                <Pressable key={sp[0]} onPress={() => openSpace(sp)} accessibilityRole="button" accessibilityLabel={`${roleLabel(sp[0])} workspace. ${sp[2]}`}>
                  <Glass radius={18} preset="clear" gloss style={{ paddingVertical: 10, paddingHorizontal: 14 }}>
                    <T weight="800" size={15} color={c.ink}>{roleLabel(sp[0])} workspace</T>
                    <T size={12} color={c.mute}>{sp[2]}</T>
                  </Glass>
                </Pressable>
              ))}
              <Pressable onPress={() => setPicker(false)} accessibilityRole="button" style={{ alignSelf: 'center', paddingVertical: 4 }}><T size={12} weight="700" color={c.mute}>Back to the swivel</T></Pressable>
            </Glass>
          </View>
        </>
      ) : null}

      <Pressable onPress={closeMenu} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" style={{ position: 'absolute', top: 14, right: 16 }}>
        <Glass radius={20} preset="soft" gloss style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}><T color={c.ink} weight="700" size={20}>×</T></Glass>
      </Pressable>
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: BAR_C + 44, alignItems: 'center' }}>
        <Glass radius={999} preset="soft" gloss style={{ paddingVertical: 4, paddingHorizontal: 12 }}><T size={11} color={c.mute} weight="700" style={{ letterSpacing: 1 }}>DRAG TO SWIVEL</T></Glass>
      </View>
    </>
  ) : null;

  const handlers = { onLayout: (e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height }), ...pan.panHandlers, ...(web ? { onWheel } : {}) };
  return (
    <Animated.View {...handlers} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 20, opacity: fade, ...(web ? { touchAction: 'pan-y' } : null) }}>
      <Glass pointerEvents="none" radius={0} blur={16} tint="rgba(0,0,0,0)" style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderWidth: 0 }} />
      <LinearGradient pointerEvents="none" colors={veil} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
      <Pressable onPress={closeMenu} accessible={false} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
      {content}
    </Animated.View>
  );
}
