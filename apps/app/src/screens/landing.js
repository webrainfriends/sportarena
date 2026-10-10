import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { locale } from '../locale';
import { Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { api } from '../api';
import { useLoad } from '../hooks';
import { T } from '../ui';
import { c, fam, day } from '../theme';
import { MarketCard, KINDS } from '../market/MarketCard';
import { useMarketActions } from '../market/actions';
import { setIntent } from '../market/intent';
import { useSports } from '../sportpicker';
import Auth from './auth';
import { HScroll, VenueBooking } from './landing-venues';

const isWeb = Platform.OS === 'web';
const h = React.createElement;
const BRAND = ['#0B1020', '#1E1B4B', '#4F46E5'];
const FLOATERS = ['⚽', '🏏', '🏀', '🎾', '🏸', '🏐', '🏑', '🥇', '🏊', '🏃', '🥊', '🏆'];

const CSS = `
@keyframes sa-float { 0%,100% { transform: translateY(0) rotate(-6deg); } 50% { transform: translateY(-26px) rotate(8deg); } }
@keyframes sa-drift { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
@keyframes sa-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
@keyframes sa-rise { from { opacity: 0; transform: translateY(26px); } to { opacity: 1; transform: none; } }
@keyframes sa-pulse { 0% { box-shadow: 0 0 0 0 rgba(52,211,153,.7); } 100% { box-shadow: 0 0 0 14px rgba(52,211,153,0); } }
@keyframes sa-shine { from { background-position: -200% 0; } to { background-position: 200% 0; } }
.sa-hero { background: linear-gradient(120deg,#0B1020,#312E81,#4F46E5,#7C3AED,#DB2777,#312E81,#0B1020); background-size: 400% 400%; animation: sa-drift 22s ease infinite; }
.sa-float { position:absolute; animation: sa-float 7s ease-in-out infinite; filter: drop-shadow(0 12px 18px rgba(0,0,0,.35)); pointer-events:none; user-select:none; }
.sa-marquee { display:flex; width:max-content; animation: sa-marquee 48s linear infinite; }
.sa-marquee:hover { animation-play-state: paused; }
.sa-rise { animation: sa-rise .9s cubic-bezier(.2,.7,.2,1) both; }
.sa-live { width:10px; height:10px; border-radius:50%; background:#34D399; animation: sa-pulse 1.6s infinite; display:inline-block; }
.sa-shine { background: linear-gradient(100deg,#fff 20%,#FDE68A 40%,#F9A8D4 60%,#fff 80%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: sa-shine 5s linear infinite; }
`;
function useWebCss() {
  useEffect(() => {
    if (!isWeb || document.getElementById('sa-landing-css')) return;
    const s = document.createElement('style'); s.id = 'sa-landing-css'; s.textContent = CSS; document.head.appendChild(s);
    document.title = 'SportArena — find athletes, matches, venues & sponsors';
  }, []);
}

function useCountUp(to) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf, t0;
    const step = (t) => { t0 ??= t; const k = Math.min(1, (t - t0) / 1400); setN(Math.round(to * (1 - (1 - k) ** 3))); if (k < 1) raf = requestAnimationFrame(step); };
    if (isWeb) raf = requestAnimationFrame(step); else setN(to);
    return () => raf && cancelAnimationFrame(raf);
  }, [to]);
  return n;
}
const Stat = ({ value, label }) => {
  const n = useCountUp(value);
  return <View style={{ minWidth: 110 }}><T color="#fff" weight="800" size={34} style={{ letterSpacing: -1 }}>{n.toLocaleString(locale)}</T><T color="#C7D2FE" weight="600" size={12} style={{ letterSpacing: 1.2 }}>{label}</T></View>;
};

const Pill = ({ title, onPress, solid, color = '#fff', style }) => (
  <Pressable onPress={onPress} style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }, style]}>
    <View style={{ paddingVertical: 14, paddingHorizontal: 26, borderRadius: 999, backgroundColor: solid ? '#fff' : 'rgba(255,255,255,0.12)', borderWidth: solid ? 0 : 1.5, borderColor: 'rgba(255,255,255,0.45)' }}>
      <T weight="800" size={15} color={solid ? '#3730A3' : color}>{title}</T>
    </View>
  </Pressable>
);

function Hero({ counts, onJoin, onBrowse, onAdvertise, wide }) {
  const nums = counts ? [[counts.people, 'ATHLETES & MEMBERS'], [counts.teams, 'TEAMS'], [counts.venues, 'VENUES'], [counts.live_events, 'LIVE EVENTS'], [counts.open_calls, 'OPEN CALLS']].filter(([v]) => v > 0) : [];
  const body = (
    <View style={{ paddingHorizontal: 20, paddingTop: wide ? 96 : 56, paddingBottom: wide ? 96 : 56, maxWidth: 1240, width: '100%', alignSelf: 'center', gap: 22 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {isWeb ? h('span', { className: 'sa-live' }) : <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: '#34D399' }} />}
        <T color="#C7D2FE" weight="700" size={12} style={{ letterSpacing: 2.5 }}>THE HOME OF SPORT · LIVE NOW</T>
      </View>
      {isWeb
        ? h('div', { className: 'sa-rise', style: { fontFamily: 'Inter, system-ui, sans-serif', fontWeight: 900, letterSpacing: '-0.04em', lineHeight: 1.02, fontSize: wide ? 88 : 46, color: '#fff', maxWidth: 900 } }, 'Where every game finds its ', h('span', { className: 'sa-shine' }, 'players, venues & sponsors.'))
        : <T color="#fff" weight="800" size={40} style={{ letterSpacing: -1.5 }}>Where every game finds its players, venues & sponsors.</T>}
      <T color="#E0E7FF" size={wide ? 20 : 16} weight="500" style={{ lineHeight: wide ? 30 : 24, maxWidth: 680 }}>Athletes wanted. Matches to join. Fixtures to follow. Kit to buy. Campaigns that move the crowd. One arena for athletes, coaches, organizers, venues and sponsors.</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 6 }}>
        <Pill solid title="Join the arena — it's free" onPress={onJoin} />
        <Pill title="Browse opportunities ↓" onPress={onBrowse} />
        <Pill title="📣 Advertise" onPress={onAdvertise} />
      </View>
      {nums.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 30, marginTop: 24 }}>{nums.map(([v, l]) => <Stat key={l} value={v} label={l} />)}</View> : null}
    </View>
  );
  if (!isWeb) return <LinearGradient colors={BRAND} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>{body}</LinearGradient>;
  return h('div', { className: 'sa-hero', style: { position: 'relative', overflow: 'hidden' } },
    // an optional hero video dropped at /hero.mp4 plays under the colour wash; if it isn't there, only the animation shows
    h('video', { src: '/hero.mp4', autoPlay: true, muted: true, loop: true, playsInline: true, onError: (e) => { e.currentTarget.style.display = 'none'; }, style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.35, mixBlendMode: 'screen' } }),
    ...FLOATERS.map((e, i) => h('span', { key: i, className: 'sa-float', style: { left: `${wide ? 56 + ((i * 7.7) % 40) : (i * 8.3 + 4) % 92}%`, top: `${[8, 62, 24, 74, 12, 50, 80, 30, 66, 6, 44, 18][i]}%`, fontSize: [54, 70, 44, 62, 50, 78, 46, 66, 56, 48, 72, 60][i], animationDelay: `${-i * 0.9}s`, animationDuration: `${6 + (i % 4)}s`, opacity: wide ? 0.55 : 0.28 } }, e)),
    h('div', { style: { position: 'absolute', inset: 0, background: 'radial-gradient(circle at 80% 20%, rgba(236,72,153,.28), transparent 45%), radial-gradient(circle at 10% 90%, rgba(56,189,248,.22), transparent 40%)', pointerEvents: 'none' } }),
    h('div', { style: { position: 'relative' } }, body));
}

/** Scrolling strip of what's coming up — real fixtures and events only. */
function Ticker({ games, events }) {
  const items = [
    ...games.map((g) => `${g.status === 'live' ? '🔴 LIVE' : '🗓️'}  ${g.home_emoji ?? ''} ${g.home_name} vs ${g.away_name} ${g.away_emoji ?? ''} · ${g.event_name}`),
    ...events.map((e) => `${e.banner_emoji ?? '🏆'}  ${e.name}${e.starts_on ? ` · ${day(e.starts_on)}` : ''}`),
  ];
  const line = items.length ? items : ['⚽ Find athletes', '🏟️ Book venues', '🏆 Run tournaments', '🤝 Meet sponsors', '🛍️ Buy & sell kit', '📣 Reach the crowd'];
  const row = line.map((t, i) => <View key={i} style={{ paddingHorizontal: 26 }}><T color="#fff" weight="700" size={14}>{t}</T></View>);
  return (
    <View style={{ backgroundColor: '#0B1020', paddingVertical: 14, overflow: 'hidden' }}>
      {isWeb ? h('div', { className: 'sa-marquee' }, h('div', { style: { display: 'flex' } }, row), h('div', { style: { display: 'flex' } }, row)) : <ScrollView horizontal showsHorizontalScrollIndicator={false}>{row}</ScrollView>}
    </View>
  );
}

function Featured({ items, gate, user }) {
  if (!items.length) return null;
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T size={22}>⭐</T><T weight="800" size={24} style={{ letterSpacing: -0.6 }}>Featured campaigns</T></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 16, paddingBottom: 10 }}>
        {items.map((p) => <View key={p.id} style={{ width: 340 }}><MarketCard p={p} user={user} gate={gate} /></View>)}
      </ScrollView>
    </View>
  );
}

const Step = ({ n, icon, title, text }) => (
  <View style={{ flex: 1, minWidth: 240, backgroundColor: c.paper, borderRadius: 22, padding: 22, borderWidth: 1, borderColor: c.line, gap: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}><T size={22}>{icon}</T></View><T color={c.mute} weight="800" size={12}>STEP {n}</T></View>
    <T weight="800" size={19}>{title}</T><T color={c.mute} size={14} style={{ lineHeight: 21 }}>{text}</T>
  </View>
);

const WHO = [
  ['🏃', 'Athletes', 'Get discovered, apply to calls, join matches, build a verified profile.', '#4F46E5'],
  ['🧑‍🏫', 'Coaches & clubs', 'Recruit players, post trials and schedules, grow your squad.', '#059669'],
  ['🏟️', 'Venues', 'Fill your slots, show off your facility with photos and video.', '#0284C7'],
  ['🤝', 'Sponsors & brands', 'Run campaigns in front of an engaged sporting crowd.', '#DB2777'],
];

export default function Landing() {
  useWebCss();
  const { width } = useWindowDimensions();
  const wide = width >= 900;
  const [auth, setAuth] = useState(null);       // { mode, intent } while the sign-in flow is open
  const [kind, setKind] = useState(null);
  const [sport, setSport] = useState(null);
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState(null);
  const scroller = useRef(null);
  const feedRef = useRef(null);
  const sports = useSports();
  const hl = useLoad(() => api.get('/market/highlights'), []);

  const PAGE = 12;
  const load = useCallback(async (offset) => {
    setBusy(true); setErr(null);
    try {
      const list = await api.get('/market/posts', { kind: kind ?? undefined, sport: sport ?? undefined, q: q.trim() || undefined, limit: PAGE, offset });
      setRows((r) => (offset ? [...r, ...list] : list)); setMore(list.length === PAGE);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }, [kind, sport, q]);
  useEffect(() => { const t = setTimeout(() => load(0), q ? 300 : 0); return () => clearTimeout(t); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const openAuth = useCallback((intent, mode = 'register') => setAuth({ mode, intent }), []);
  const onPatch = useCallback((id, patch) => setRows((r) => r.map((p) => (p.id === id ? { ...p, ...patch } : p))), []);
  const { gate } = useMarketActions({ openAuth: (i) => openAuth(i), onPatch });
  const start = (action) => { const i = { action }; setIntent(i); openAuth(i, action === 'login' ? 'login' : 'register'); };
  const browse = () => {
    const node = feedRef.current;
    if (isWeb) node?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    else node?.measureLayout?.(scroller.current.getInnerViewNode?.() ?? scroller.current, (_x, y) => scroller.current.scrollTo({ y: y - 70, animated: true }));
  };

  const cols = width >= 1180 ? 3 : width >= 720 ? 2 : 1;
  const columns = useMemo(() => { const out = Array.from({ length: cols }, () => []); rows.forEach((p, i) => out[i % cols].push(p)); return out; }, [rows, cols]);

  if (auth) return <Auth intent={auth.intent} initialMode={auth.mode} onClose={() => setAuth(null)} />;

  const d = hl.data;
  const wrap = { width: '100%', maxWidth: 1240, alignSelf: 'center', paddingHorizontal: 20 };
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {/* sticky nav */}
      <View style={{ backgroundColor: 'rgba(11,16,32,0.96)', borderBottomWidth: 1, borderColor: 'rgba(255,255,255,0.08)', zIndex: 5 }}>
        <View style={[wrap, { height: 64, flexDirection: 'row', alignItems: 'center', gap: 14 }]}>
          <T color="#fff" weight="800" size={22} style={{ letterSpacing: -0.8 }}>🏟️ SportArena</T>
          <View style={{ flex: 1 }} />
          {wide ? [['Opportunities', browse], ['Advertise', () => start('advertise')]].map(([l, f]) => <Pressable key={l} onPress={f}><T color="#C7D2FE" weight="700" size={14}>{l}</T></Pressable>) : null}
          <Pressable onPress={() => start('login')}><T color="#fff" weight="700" size={14}>Log in</T></Pressable>
          <Pressable onPress={() => start('join')} style={{ backgroundColor: '#4F46E5', borderRadius: 999, paddingVertical: 9, paddingHorizontal: 18 }}><T color="#fff" weight="800" size={13}>Join free</T></Pressable>
        </View>
      </View>

      <ScrollView ref={scroller} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 0 }}>
        <Hero counts={d?.counts} wide={wide} onJoin={() => start('join')} onBrowse={browse} onAdvertise={() => start('advertise')} />
        <Ticker games={d?.games ?? []} events={d?.events ?? []} />

        <View style={[wrap, { paddingTop: 44, gap: 44 }]}>
          <Featured items={d?.featured ?? []} gate={gate} user={null} />

          <View style={{ gap: 16 }}>
            <View>
              <T weight="800" size={wide ? 36 : 28} style={{ letterSpacing: -1.2 }}>Book a venue</T>
              <T color={c.mute} size={15} style={{ marginTop: 4 }}>See open slots and prices for courts and grounds near you. Pick a time, then log in or create an account to confirm.</T>
            </View>
            <VenueBooking wide={wide} sport={sport} onBook={(b) => { const i = { action: 'book', title: b.venueName, ...b }; setIntent(i); openAuth(i, 'register'); }} />
          </View>

          <View ref={feedRef} style={{ gap: 16, scrollMarginTop: 80 }}>
            <View>
              <T weight="800" size={wide ? 36 : 28} style={{ letterSpacing: -1.2 }}>What's happening in the arena</T>
              <T color={c.mute} size={15} style={{ marginTop: 4 }}>Opportunities, matches, schedules and kit — posted by the community. Sign in to apply, contact or follow anyone.</T>
            </View>
            <HScroll>
              {[[null, '✨ All'], ...Object.entries(KINDS).map(([k, v]) => [k, `${v.emoji} ${v.label}`])].map(([k, l]) => (
                <Pressable key={l} onPress={() => setKind(k)} style={{ paddingVertical: 10, paddingHorizontal: 18, borderRadius: 999, backgroundColor: kind === k ? c.ink : c.paper, borderWidth: 1, borderColor: kind === k ? c.ink : c.line }}><T weight="700" size={14} color={kind === k ? c.inkOn : c.mute}>{l}</T></Pressable>
              ))}
            </HScroll>
            <View style={{ flexDirection: wide ? 'row' : 'column', gap: 10 }}>
              <TextInput value={q} onChangeText={setQ} placeholder="Search wanted ads, matches, kit…" placeholderTextColor="#94A3B8" style={[fam, { flex: wide ? 0 : undefined, width: wide ? 300 : undefined, backgroundColor: c.paper, borderRadius: 14, borderWidth: 1, borderColor: c.line, paddingHorizontal: 16, paddingVertical: 12, fontSize: 15 }, isWeb && { outlineStyle: 'none' }]} />
              <HScroll gap={6} style={wide ? { flex: 1 } : undefined}>
                <Pressable onPress={() => setSport(null)} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: sport ? c.paper : c.pinkSoft }}><T size={13} weight="700" color={c.pink}>All sports</T></Pressable>
                {(sports.data ?? []).map((s) => <Pressable key={s.slug} onPress={() => setSport(s.slug === sport ? null : s.slug)} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: sport === s.slug ? c.pinkSoft : c.paper, borderWidth: 1, borderColor: sport === s.slug ? c.pink : c.line }}><T size={13} weight="700" color={sport === s.slug ? c.pink : '#334155'}>{s.emoji} {s.name}</T></Pressable>)}
              </HScroll>
            </View>

            {err ? <T color={c.red} weight="600">{err}</T> : null}
            {!rows.length && !busy && !err ? (
              <View style={{ alignItems: 'center', gap: 10, padding: 48, backgroundColor: c.paper, borderRadius: 24, borderWidth: 1, borderColor: c.line }}>
                <T size={54}>🏟️</T><T weight="800" size={22}>The arena is waiting for its first post</T>
                <T color={c.mute} style={{ textAlign: 'center', maxWidth: 440 }}>{kind || sport || q ? 'Nothing matches those filters yet. Try clearing them, or post what you are looking for.' : 'Need athletes? Hosting a match? Selling kit? Be the first to put it in front of the community.'}</T>
                <Pressable onPress={() => start('post')} style={{ backgroundColor: c.pink, borderRadius: 999, paddingVertical: 13, paddingHorizontal: 26, marginTop: 6 }}><T color="#fff" weight="800">Create the first post</T></Pressable>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', gap: 18, alignItems: 'flex-start' }}>
                {columns.map((col, i) => <View key={i} style={{ flex: 1, gap: 18 }}>{col.map((p) => <MarketCard key={p.id} p={p} user={null} gate={gate} />)}</View>)}
              </View>
            )}
            {busy ? <T color={c.mute} style={{ textAlign: 'center' }}>Loading…</T> : more ? <Pressable onPress={() => load(rows.length)} style={{ alignSelf: 'center', borderRadius: 999, borderWidth: 1.5, borderColor: c.ink, paddingVertical: 12, paddingHorizontal: 28 }}><T weight="800">Show more</T></Pressable> : null}
            {rows.length ? <View style={{ alignItems: 'center', padding: 22, backgroundColor: c.pinkSoft, borderRadius: 20, gap: 8 }}><T weight="800" size={17}>Want to apply, contact someone or see full profiles?</T><Pressable onPress={() => start('join')}><T color={c.pink} weight="800">Create a free account →</T></Pressable></View> : null}
          </View>

          <View style={{ gap: 16 }}>
            <T weight="800" size={wide ? 36 : 28} style={{ letterSpacing: -1.2 }}>How it works</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
              <Step n={1} icon="👀" title="Browse freely" text="Every public post is open to see — wanted athletes, matches, schedules, kit for sale and campaigns." />
              <Step n={2} icon="🔐" title="Sign in when you're ready" text="Tap Apply or Contact and we guide you through a quick sign-up, then bring you back to exactly where you were." />
              <Step n={3} icon="🚀" title="Play, hire, sell, sponsor" text="Apply, get accepted, track responses — your feed keeps you posted like a professional network for sport." />
            </View>
          </View>

          <View style={{ gap: 16 }}>
            <T weight="800" size={wide ? 36 : 28} style={{ letterSpacing: -1.2 }}>Built for everyone in the game</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
              {WHO.map(([e, t, s, col]) => (
                <Pressable key={t} onPress={() => start('join')} style={{ flex: 1, minWidth: 240 }}>
                  <LinearGradient colors={[col, `${col}CC`]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 24, padding: 24, minHeight: 190, justifyContent: 'flex-end' }}>
                    <T size={44} style={{ position: 'absolute', top: 14, right: 18 }}>{e}</T><T color="#fff" weight="800" size={21}>{t}</T><T color="rgba(255,255,255,0.88)" size={14} style={{ marginTop: 4, lineHeight: 20 }}>{s}</T>
                  </LinearGradient>
                </Pressable>
              ))}
            </View>
          </View>

          <LinearGradient colors={['#4F46E5', '#DB2777']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 28, padding: wide ? 56 : 28, gap: 14, alignItems: 'flex-start' }}>
            <T color="#fff" weight="800" size={wide ? 42 : 28} style={{ letterSpacing: -1.5, maxWidth: 720 }}>Put your brand, event or team in front of the arena.</T>
            <T color="#FCE7F3" size={16} style={{ maxWidth: 620, lineHeight: 24 }}>Run a campaign on the home page with photos, GIFs and video. Reviewed within your window, labelled Sponsored, seen by every visitor.</T>
            <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}><Pill solid title="Start a campaign" onPress={() => start('advertise')} /><Pill title="Post for free" onPress={() => start('post')} /></View>
          </LinearGradient>
        </View>

        <View style={{ backgroundColor: '#0B1020', marginTop: 56, paddingVertical: 36 }}>
          <View style={[wrap, { flexDirection: wide ? 'row' : 'column', gap: 14, justifyContent: 'space-between' }]}>
            <View><T color="#fff" weight="800" size={20}>🏟️ SportArena</T><T color="#94A3B8" size={13} style={{ marginTop: 4 }}>The home of sport. Teams · Fixtures · Venues · Performance.</T></View>
            <View style={{ flexDirection: 'row', gap: 22 }}>
              <Pressable onPress={() => start('login')}><T color="#C7D2FE" weight="700" size={13}>Log in</T></Pressable>
              <Pressable onPress={() => start('join')}><T color="#C7D2FE" weight="700" size={13}>Create account</T></Pressable>
              <Pressable onPress={() => start('advertise')}><T color="#C7D2FE" weight="700" size={13}>Advertise</T></Pressable>
            </View>
          </View>
        </View>
      </ScrollView>

      <Pressable onPress={() => start('post')} style={{ position: 'absolute', right: 20, bottom: 24, backgroundColor: c.pink, borderRadius: 999, paddingVertical: 14, paddingHorizontal: 22, shadowColor: '#4F46E5', shadowOpacity: 0.5, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } }}>
        <T color="#fff" weight="800" size={14}>＋ Post</T>
      </Pressable>
    </View>
  );
}
