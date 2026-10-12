import React, { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

const h = React.createElement;
const SCENE_MS = 3400;

/**
 * Portrait promo card for the landing page (web only). It loops forever, muted, from the moment the page opens.
 *
 * Real footage wins: drop a 9:16 video at `public/promo.mp4` (up to 2160×3840) and it plays instead of the built-in
 * scenes. Otherwise the card runs one motion-graphic scene per feature, and each scene shows a real photo if one is
 * dropped at `public/promo/<scene>.jpg` (athletes, venues, events, sponsors, medical, stats, hiring) — no photo, no
 * image, just the gradient. Nothing here is sample data: the copy only names what the app does.
 */
export const SCENES = [
  { id: 'athletes', emoji: '🏃‍♀️', kicker: 'ATHLETES', title: 'Get discovered', text: 'A verified profile, your sport, your stats — in front of coaches and clubs.', colors: ['#4F46E5', '#7C3AED'] },
  { id: 'teams', emoji: '🏆', kicker: 'TEAMS & MATCHES', title: 'Find your game', text: 'Join matches, build squads, follow fixtures and live scores.', colors: ['#059669', '#0EA5A4'] },
  { id: 'venues', emoji: '🏟️', kicker: 'VENUES', title: 'Fill every slot', text: 'Courts and grounds with open times, prices and instant booking.', colors: ['#0284C7', '#4F46E5'] },
  { id: 'events', emoji: '📅', kicker: 'EVENT MANAGEMENT', title: 'Run the whole event', text: 'Teams, boards, schedules, games, venues and results in one console.', colors: ['#DB2777', '#7C3AED'] },
  { id: 'sponsors', emoji: '🤝', kicker: 'SPONSORS & BRANDS', title: 'Back the game', text: 'Campaigns in front of an engaged sporting crowd.', colors: ['#D97706', '#DB2777'] },
  { id: 'medical', emoji: '🩺', kicker: 'PHYSIOS & DOCTORS', title: 'Stay in the game', text: 'Sports medics and physios on hand — for athletes and for events.', colors: ['#0891B2', '#059669'] },
  { id: 'stats', emoji: '📊', kicker: 'STATS', title: 'Know your numbers', text: 'Performance, results and standings that follow you everywhere.', colors: ['#7C3AED', '#2563EB'] },
  { id: 'hiring', emoji: '🧢', kicker: 'HIRING', title: 'Work at the big day', text: 'Referees, scorers, medics and crew — apply and sign your contract.', colors: ['#EA580C', '#DB2777'] },
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

export function PromoCard({ onJoin, width = 340 }) {
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
  if (Platform.OS !== 'web') return null;

  const sc = SCENES[i];
  const height = Math.round(width * 16 / 9);
  const frame = {
    position: 'relative', width, height, maxWidth: '100%', borderRadius: 34, overflow: 'hidden', background: '#0B1020', color: '#fff',
    fontFamily: 'Inter, system-ui, sans-serif', boxShadow: '0 0 0 8px #0B1020, 0 0 0 9.5px rgba(255,255,255,.18), 0 40px 80px rgba(0,0,0,.55), 0 0 90px rgba(124,58,237,.35)',
  };
  const joinBtn = h('button', { onClick: onJoin, style: { position: 'absolute', left: 18, right: 18, bottom: 18, border: 0, cursor: 'pointer', borderRadius: 999, padding: '14px 18px', background: '#fff', color: '#3730A3', fontWeight: 800, fontSize: 15, fontFamily: 'inherit', boxShadow: '0 10px 30px rgba(0,0,0,.4)' } }, 'Join the arena — it’s free');

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
        h('div', { style: { fontSize: 12, fontWeight: 800, letterSpacing: 2.4, color: '#E0E7FF' } }, sc.kicker),
        h('div', { style: { fontSize: Math.round(width * 0.115), fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1.04, margin: '6px 0 8px' } }, sc.title),
        h('div', { style: { fontSize: 15, lineHeight: 1.4, color: '#E0E7FF', fontWeight: 500 } }, sc.text))),
    // story-style progress bars
    video ? null : h('div', { style: { position: 'absolute', top: 14, left: 16, right: 16, display: 'flex', gap: 4, zIndex: 3 } },
      SCENES.map((s, k) => h('div', { key: s.id, style: { flex: 1, height: 3, borderRadius: 2, background: 'rgba(255,255,255,.28)', overflow: 'hidden' } },
        h('div', { key: k === i ? `on${i}` : 'off', className: k === i ? 'sa-promo-bar' : undefined, style: { height: '100%', background: '#fff', transform: k < i ? 'scaleX(1)' : k === i ? undefined : 'scaleX(0)', animationPlayState: hidden ? 'paused' : 'running' } })))),
    h('div', { style: { position: 'absolute', zIndex: 4, left: 0, right: 0, bottom: 0, height: 0 } }, joinBtn));
}
