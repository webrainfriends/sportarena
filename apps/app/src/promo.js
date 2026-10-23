import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

const h = React.createElement;
const SCENE_MS = 3400;

/**
 * Portrait promo card for the landing page (web and native). It loops forever, muted, from the moment the page opens.
 *
 * Real footage wins: drop a 9:16 video at `public/promo.mp4` (up to 2160×3840) and it plays instead of the built-in
 * scenes. Otherwise the card runs one motion-graphic scene per feature, and each scene shows a real photo if one is
 * dropped at `public/promo/<scene>.jpg` (athletes, venues, events, sponsors, medical, stats, hiring) — no photo, no
 * image, just the gradient. Nothing here is sample data: the copy only names what the app does.
 */
export const SCENES = [
  { id: 'athletes', emoji: '🏃‍♀️', kicker: 'ATHLETES', title: 'Get discovered', text: 'A verified profile, your sport, your stats — in front of coaches and clubs.', colors: ['#4A5FD9', '#2A2773'] },
  { id: 'teams', emoji: '🏆', kicker: 'TEAMS & MATCHES', title: 'Find your game', text: 'Join matches, build squads, follow fixtures and live scores.', colors: ['#059669', '#0EA5A4'] },
  { id: 'venues', emoji: '🏟️', kicker: 'VENUES', title: 'Fill every slot', text: 'Courts and grounds with open times, prices and instant booking.', colors: ['#0284C7', '#4A5FD9'] },
  { id: 'events', emoji: '📅', kicker: 'EVENT MANAGEMENT', title: 'Run the whole event', text: 'Teams, boards, schedules, games, venues and results in one console.', colors: ['#5B6FE0', '#2A2773'] },
  { id: 'sponsors', emoji: '🤝', kicker: 'SPONSORS & BRANDS', title: 'Back the game', text: 'Campaigns in front of an engaged sporting crowd.', colors: ['#D97706', '#5B6FE0'] },
  { id: 'medical', emoji: '🩺', kicker: 'PHYSIOS & DOCTORS', title: 'Stay in the game', text: 'Sports medics and physios on hand — for athletes and for events.', colors: ['#0891B2', '#059669'] },
  { id: 'stats', emoji: '📊', kicker: 'STATS', title: 'Know your numbers', text: 'Performance, results and standings that follow you everywhere.', colors: ['#2A2773', '#2563EB'] },
  { id: 'hiring', emoji: '🧢', kicker: 'HIRING', title: 'Work at the big day', text: 'Referees, scorers, medics and crew — apply and sign your contract.', colors: ['#EA580C', '#5B6FE0'] },
];

const CSS = `
@keyframes sa-promo-in { from { opacity: 0; transform: translateY(22px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes sa-promo-zoom { from { transform: scale(1.04); } to { transform: scale(1.16); } }
@keyframes sa-promo-bar { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes sa-promo-emoji { 0%,100% { transform: translateY(0) rotate(-5deg); } 50% { transform: translateY(-14px) rotate(6deg); } }
.sa-promo-zoom { animation: sa-promo-zoom ${SCENE_MS + 600}ms ease-out both; }
.sa-promo-in { animation: sa-promo-in .7s cubic-bezier(.2,.7,.2,1) both; }
.sa-promo-bar { transform-origin: left; animation: sa-promo-bar ${SCENE_MS}ms linear both; }
.sa-promo-emoji { animation: sa-promo-emoji 3.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .sa-promo-zoom, .sa-promo-emoji { animation: none; } }
`;

/** Native (iOS/Android) version of the card: the same scenes, driven by Animated instead of CSS. */
function PromoCardNative({ onJoin, width }) {
  const [i, setI] = useState(0);
  const enter = useRef(new Animated.Value(0)).current;
  const bar = useRef(new Animated.Value(0)).current;
  const bob = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % SCENES.length), SCENE_MS);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    enter.setValue(0); bar.setValue(0);
    Animated.timing(enter, { toValue: 1, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    Animated.timing(bar, { toValue: 1, duration: SCENE_MS, easing: Easing.linear, useNativeDriver: true }).start();
  }, [i, enter, bar]);
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(bob, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(bob, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [bob]);

  const sc = SCENES[i];
  const height = Math.round(width * 16 / 9);
  const rise = enter.interpolate({ inputRange: [0, 1], outputRange: [22, 0] });
  return (
    <View accessibilityRole="summary" accessibilityLabel="Gotmygame in 30 seconds" style={{ width, height, maxWidth: '100%', borderRadius: 34, overflow: 'hidden', backgroundColor: '#0B1020', borderWidth: 6, borderColor: '#0B1020', shadowColor: '#2A2773', shadowOpacity: 0.45, shadowRadius: 30, shadowOffset: { width: 0, height: 18 }, elevation: 12 }}>
      <LinearGradient key={sc.id} colors={[sc.colors[0], sc.colors[1], '#0B1020']} locations={[0, 0.6, 1]} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill}>
        <Animated.Text style={{ position: 'absolute', top: '17%', left: 0, right: 0, textAlign: 'center', fontSize: Math.round(width * 0.36), transform: [{ translateY: bob.interpolate({ inputRange: [0, 1], outputRange: [0, -14] }) }, { rotate: bob.interpolate({ inputRange: [0, 1], outputRange: ['-5deg', '6deg'] }) }] }}>{sc.emoji}</Animated.Text>
        <Animated.View style={{ position: 'absolute', left: 22, right: 22, bottom: 86, opacity: enter, transform: [{ translateY: rise }] }}>
          <Text style={{ fontSize: 12, fontWeight: '800', letterSpacing: 2.4, color: '#D3D3FF' }}>{sc.kicker}</Text>
          <Text style={{ fontSize: Math.round(width * 0.115), fontWeight: '900', letterSpacing: -1.2, lineHeight: Math.round(width * 0.12), marginTop: 6, marginBottom: 8, color: '#fff' }}>{sc.title}</Text>
          <Text style={{ fontSize: 15, lineHeight: 21, color: '#D3D3FF', fontWeight: '500' }}>{sc.text}</Text>
        </Animated.View>
      </LinearGradient>
      <View style={{ position: 'absolute', top: 14, left: 16, right: 16, flexDirection: 'row', gap: 4 }}>
        {SCENES.map((s, k) => (
          <View key={s.id} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,.28)', overflow: 'hidden' }}>
            {k < i ? <View style={{ flex: 1, backgroundColor: '#fff' }} />
              : k === i ? <Animated.View style={{ flex: 1, backgroundColor: '#fff', transform: [{ translateX: bar.interpolate({ inputRange: [0, 1], outputRange: [-1000, 0] }) }] }} /> : null}
          </View>
        ))}
      </View>
      <Pressable onPress={onJoin} accessibilityRole="button" style={{ position: 'absolute', left: 18, right: 18, bottom: 18, borderRadius: 999, paddingVertical: 14, paddingHorizontal: 18, backgroundColor: '#fff', alignItems: 'center' }}>
        <Text style={{ color: '#2A2773', fontWeight: '800', fontSize: 15 }}>Join the arena — it’s free</Text>
      </Pressable>
    </View>
  );
}

export function PromoCard({ onJoin, width = 340 }) {
  return Platform.OS === 'web' ? <PromoCardWeb onJoin={onJoin} width={width} /> : <PromoCardNative onJoin={onJoin} width={width} />;
}

function PromoCardWeb({ onJoin, width }) {
  const [i, setI] = useState(0);
  const [video, setVideo] = useState(false);
  const [hidden, setHidden] = useState(false);
  const shell = useRef(null);

  useEffect(() => {
    if (Platform.OS !== 'web' || document.getElementById('sa-promo-css')) return;
    const s = document.createElement('style'); s.id = 'sa-promo-css'; s.textContent = CSS; document.head.appendChild(s);
  }, []);
  // keep cycling for as long as the card is on the page; rest while the tab is in the background
  useEffect(() => {
    if (video || hidden) return undefined;
    const t = setInterval(() => setI((n) => (n + 1) % SCENES.length), SCENE_MS);
    return () => clearInterval(t);
  }, [video, hidden]);
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const f = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, []);
  const sc = SCENES[i];
  const height = Math.round(width * 16 / 9);
  const frame = {
    position: 'relative', width, height, maxWidth: '100%', borderRadius: 34, overflow: 'hidden', background: '#0B1020', color: '#fff',
    fontFamily: 'Inter, system-ui, sans-serif', boxShadow: '0 0 0 8px #0B1020, 0 0 0 9.5px rgba(255,255,255,.18), 0 40px 80px rgba(0,0,0,.55), 0 0 90px rgba(42,39,115,.35)',
  };
  const joinBtn = h('button', { onClick: onJoin, style: { position: 'absolute', left: 18, right: 18, bottom: 18, border: 0, cursor: 'pointer', borderRadius: 999, padding: '14px 18px', background: '#fff', color: '#2A2773', fontWeight: 800, fontSize: 15, fontFamily: 'inherit', boxShadow: '0 10px 30px rgba(0,0,0,.4)' } }, 'Join the arena — it’s free');

  return h('div', { ref: shell, style: frame, role: 'region', 'aria-label': 'Gotmygame in 30 seconds' },
    // real footage, when it exists
    h('video', {
      src: '/promo.mp4', autoPlay: true, muted: true, loop: true, playsInline: true, preload: 'auto',
      onCanPlay: () => setVideo(true), onError: (e) => { e.currentTarget.style.display = 'none'; setVideo(false); },
      style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: video ? 'block' : 'none', zIndex: 2 },
    }),
    // built-in scenes
    h('div', { key: sc.id, style: { position: 'absolute', inset: 0, background: `linear-gradient(160deg, ${sc.colors[0]}, ${sc.colors[1]} 60%, #0B1020)` } },
      h('img', { src: `/promo/${sc.id}.jpg`, alt: '', className: 'sa-promo-zoom', onError: (e) => { e.currentTarget.style.display = 'none'; }, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' } }),
      h('div', { style: { position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(11,16,32,.35) 0%, rgba(11,16,32,0) 35%, rgba(11,16,32,.88) 100%)' } }),
      h('div', { className: 'sa-promo-emoji', style: { position: 'absolute', top: '17%', left: 0, right: 0, textAlign: 'center', fontSize: Math.round(width * 0.36), filter: 'drop-shadow(0 18px 24px rgba(0,0,0,.45))' } }, sc.emoji),
      h('div', { className: 'sa-promo-in', style: { position: 'absolute', left: 22, right: 22, bottom: 86 } },
        h('div', { style: { fontSize: 12, fontWeight: 800, letterSpacing: 2.4, color: '#D3D3FF' } }, sc.kicker),
        h('div', { style: { fontSize: Math.round(width * 0.115), fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1.04, margin: '6px 0 8px' } }, sc.title),
        h('div', { style: { fontSize: 15, lineHeight: 1.4, color: '#D3D3FF', fontWeight: 500 } }, sc.text))),
    // story-style progress bars
    video ? null : h('div', { style: { position: 'absolute', top: 14, left: 16, right: 16, display: 'flex', gap: 4, zIndex: 3 } },
      SCENES.map((s, k) => h('div', { key: s.id, style: { flex: 1, height: 3, borderRadius: 2, background: 'rgba(255,255,255,.28)', overflow: 'hidden' } },
        h('div', { key: k === i ? `on${i}` : 'off', className: k === i ? 'sa-promo-bar' : undefined, style: { height: '100%', background: '#fff', transform: k < i ? 'scaleX(1)' : k === i ? undefined : 'scaleX(0)', animationPlayState: hidden ? 'paused' : 'running' } })))),
    h('div', { style: { position: 'absolute', zIndex: 4, left: 0, right: 0, bottom: 0, height: 0 } }, joinBtn));
}
