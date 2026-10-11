// "Arena": the vibrant look of the event command centre — electric gradients on a deep midnight canvas, bold type, glowing
// live states and sticker-like chips, made for a Gen-Z crowd that lives on its phone. Event screens opt in by using these
// components; the rest of the app keeps its calmer theme. Fixed dark palette on purpose: scoreboards read best that way.
import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, ScrollView, Text, View, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { fam } from './theme';
import { useLayout } from './layout';
import { Field, Sheet } from './ui';

export const A = {
  bg: '#0A0716', panel: '#151030', panel2: '#1E1745', line: 'rgba(255,255,255,0.10)', ink: '#F8F5FF', mute: '#A79FCB',
  violet: '#8B5CF6', magenta: '#EC4899', cyan: '#22D3EE', lime: '#A3E635', sun: '#FBBF24', orange: '#FB923C', red: '#F43F5E', green: '#34D399',
};
export const AG = {
  hero: ['#7C3AED', '#EC4899'], neon: ['#06B6D4', '#8B5CF6'], lime: ['#A3E635', '#22D3EE'], live: ['#F43F5E', '#FB923C'], sun: ['#FBBF24', '#FB923C'], night: ['#1E1745', '#0A0716'],
};
const INK_ON = { lime: '#0A0716', sun: '#0A0716' };

const glow = (color, k = 0.45, r = 18) => (Platform.OS === 'web'
  ? { boxShadow: `0 6px ${r + 6}px ${color}${Math.round(k * 255).toString(16).padStart(2, '0')}` }
  : { shadowColor: color, shadowOpacity: k, shadowRadius: r, shadowOffset: { width: 0, height: 6 }, elevation: 6 });
export { glow };

/** Text in the Arena palette. weight: 400–900; tabular numbers for scores. */
export const AT = ({ children, size = 15, color = A.ink, weight = '600', style, num, ...p }) =>
  <Text {...p} style={[fam, { fontSize: size, color, fontWeight: weight, letterSpacing: size > 24 ? -0.8 : 0 }, num ? { fontVariant: ['tabular-nums'] } : null, style]}>{children}</Text>;

export function useReducedMotion() {
  const [on, setOn] = useState(false);
  useEffect(() => { AccessibilityInfo.isReduceMotionEnabled?.().then(setOn).catch(() => {}); }, []);
  return on;
}

/** The midnight canvas with two soft colour blobs behind the content. */
export function AScreen({ children, scroll = true, refreshControl, padBottom }) {
  const L = useLayout();
  const body = (
    <View style={{ paddingHorizontal: L.gutter, paddingTop: 8, paddingBottom: padBottom ?? L.bottomPad, maxWidth: L.contentMax, width: '100%', alignSelf: 'center', gap: 14 }}>{children}</View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: A.bg }}>
      <View pointerEvents="none" style={{ position: 'absolute', top: -120, right: -80, width: 320, height: 320, borderRadius: 160, backgroundColor: A.violet, opacity: 0.22 }} />
      <View pointerEvents="none" style={{ position: 'absolute', top: 260, left: -140, width: 300, height: 300, borderRadius: 150, backgroundColor: A.magenta, opacity: 0.12 }} />
      {scroll ? <ScrollView refreshControl={refreshControl} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>{body}</ScrollView> : body}
    </View>
  );
}

export function ACard({ children, onPress, tone, pad = 16, style }) {
  const edge = tone ?? A.line;
  const inner = <View style={[{ backgroundColor: A.panel, borderRadius: 22, borderWidth: 1, borderColor: edge, padding: pad }, tone ? glow(tone, 0.18, 14) : null, style]}>{children}</View>;
  return onPress ? <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1, transform: [{ scale: pressed ? 0.985 : 1 }] })}>{inner}</Pressable> : inner;
}

/** Big gradient banner: kicker, huge title, optional emoji sticker and extra content. */
export function AHero({ kicker, title, sub, emoji, tone = AG.hero, children }) {
  return (
    <View style={[{ borderRadius: 28, overflow: 'hidden' }, glow(tone[0], 0.35, 24)]}>
      <LinearGradient colors={tone} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ padding: 20 }}>
        <View pointerEvents="none" style={{ position: 'absolute', right: -30, top: -50, width: 180, height: 180, borderRadius: 90, backgroundColor: '#fff', opacity: 0.14 }} />
        {emoji ? <View style={{ position: 'absolute', right: 16, top: 12, transform: [{ rotate: '12deg' }] }}><Text style={{ fontSize: 54 }}>{emoji}</Text></View> : null}
        {kicker ? <AT size={11} weight="800" color="rgba(255,255,255,0.8)" style={{ letterSpacing: 1.6 }}>{String(kicker).toUpperCase()}</AT> : null}
        <AT size={30} weight="900" color="#fff" style={{ marginTop: 4, paddingRight: emoji ? 64 : 0, lineHeight: 34 }}>{title}</AT>
        {sub ? <AT size={14} weight="600" color="rgba(255,255,255,0.85)" style={{ marginTop: 6, paddingRight: emoji ? 56 : 0 }}>{sub}</AT> : null}
        {children}
      </LinearGradient>
    </View>
  );
}

/** Gradient pill button with a springy press. tone: hero | neon | lime | live | sun | ghost */
export function ABtn({ title, onPress, tone = 'hero', small, disabled, loading, style }) {
  const sc = useRef(new Animated.Value(1)).current;
  const to = (v) => Animated.spring(sc, { toValue: v, useNativeDriver: true, speed: 40, bounciness: 8 }).start();
  const ghost = tone === 'ghost';
  const ink = INK_ON[tone] ?? '#fff';
  const inner = (
    <View style={{ paddingVertical: small ? 10 : 15, paddingHorizontal: small ? 18 : 26, minHeight: small ? 40 : 52, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }}>
      {loading ? <ActivityIndicator color={ghost ? A.ink : ink} /> : <AT weight="800" size={small ? 13 : 15} color={ghost ? A.ink : ink}>{title}</AT>}
    </View>
  );
  return (
    <Pressable disabled={disabled || loading} onPress={onPress} onPressIn={() => to(0.96)} onPressOut={() => to(1)} accessibilityRole="button" accessibilityLabel={title} style={[{ opacity: disabled ? 0.4 : 1 }, style]}>
      <Animated.View style={{ transform: [{ scale: sc }], borderRadius: 999, overflow: 'hidden', ...(ghost ? { borderWidth: 1.5, borderColor: A.line, backgroundColor: A.panel2 } : glow((AG[tone] ?? AG.hero)[0], 0.4, 14)) }}>
        {ghost ? inner : <LinearGradient colors={AG[tone] ?? AG.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>{inner}</LinearGradient>}
      </Animated.View>
    </Pressable>
  );
}

export const AChip = ({ label, active, onPress, color = A.violet, badge, style }) => (
  <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: !!active }} style={({ pressed }) => [{ opacity: pressed ? 0.8 : 1, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingVertical: 9, paddingHorizontal: 15, minHeight: 40, borderWidth: 1.5, borderColor: active ? color : A.line, backgroundColor: active ? `${color}33` : A.panel }, style]}>
    <AT size={13} weight="800" color={active ? '#fff' : A.mute}>{label}</AT>
    {badge ? <View style={{ minWidth: 18, height: 18, borderRadius: 9, backgroundColor: A.magenta, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 }}><AT size={10} weight="900" color="#fff">{badge}</AT></View> : null}
  </Pressable>
);

export function ATabs({ tabs, value, onChange }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
      {tabs.map((t) => {
        const on = t.key === value;
        return (
          <Pressable key={t.key} onPress={() => onChange(t.key)} accessibilityRole="tab" accessibilityState={{ selected: on }}>
            <View style={[{ borderRadius: 999, overflow: 'hidden' }, on ? glow(A.violet, 0.45, 12) : null]}>
              {on
                ? <LinearGradient colors={AG.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ paddingVertical: 10, paddingHorizontal: 16, flexDirection: 'row', gap: 6, alignItems: 'center' }}><AT size={13} weight="800" color="#fff">{t.icon ? `${t.icon} ` : ''}{t.label}</AT></LinearGradient>
                : <View style={{ paddingVertical: 10, paddingHorizontal: 16, flexDirection: 'row', gap: 6, alignItems: 'center', backgroundColor: A.panel, borderWidth: 1, borderColor: A.line, borderRadius: 999 }}><AT size={13} weight="700" color={A.mute}>{t.icon ? `${t.icon} ` : ''}{t.label}</AT>{t.badge ? <View style={{ minWidth: 18, height: 18, borderRadius: 9, backgroundColor: A.magenta, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 }}><AT size={10} weight="900" color="#fff">{t.badge}</AT></View> : null}</View>}
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export const ASection = ({ title, sub, action, onAction }) => (
  <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 10 }}>
    <View style={{ flexShrink: 1 }}><AT size={20} weight="900">{title}</AT>{sub ? <AT size={12.5} weight="600" color={A.mute} style={{ marginTop: 2 }}>{sub}</AT> : null}</View>
    {action ? <Pressable onPress={onAction} hitSlop={10}><AT size={13} weight="800" color={A.cyan}>{action} ›</AT></Pressable> : null}
  </View>
);

export const AEmpty = ({ emoji = '🫥', title, sub, action, onAction }) => (
  <ACard><View style={{ alignItems: 'center', gap: 6, paddingVertical: 14 }}>
    <Text style={{ fontSize: 38 }}>{emoji}</Text><AT size={16} weight="800">{title}</AT>
    {sub ? <AT size={13} color={A.mute} style={{ textAlign: 'center' }}>{sub}</AT> : null}
    {action ? <ABtn small title={action} onPress={onAction} style={{ marginTop: 8 }} /> : null}
  </View></ACard>
);

export const STATUS = {
  live: { label: 'LIVE', colors: AG.live, dot: A.red, pulse: true }, paused: { label: 'PAUSED', colors: AG.sun, dot: A.sun },
  finished: { label: 'FULL TIME', colors: AG.neon, dot: A.cyan }, completed: { label: 'FINAL', colors: ['#10B981', '#34D399'], dot: A.green },
  scheduled: { label: 'UPCOMING', colors: ['#3B2F7A', '#2A2160'], dot: A.mute }, postponed: { label: 'POSTPONED', colors: ['#3B2F7A', '#2A2160'], dot: A.sun },
  abandoned: { label: 'ABANDONED', colors: ['#3B2F7A', '#2A2160'], dot: A.red }, cancelled: { label: 'CANCELLED', colors: ['#3B2F7A', '#2A2160'], dot: A.red },
  draft: { label: 'DRAFT', colors: ['#3B2F7A', '#2A2160'], dot: A.mute }, open: { label: 'OPEN', colors: AG.neon, dot: A.cyan }, ongoing: { label: 'RUNNING', colors: AG.live, dot: A.red, pulse: true },
};

/** Status sticker. A running state pulses (unless the device asks for reduced motion). */
export function LiveBadge({ status, label }) {
  const st = STATUS[status] ?? STATUS.scheduled;
  const reduce = useReducedMotion();
  const o = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!st.pulse || reduce) return undefined;
    const a = Animated.loop(Animated.sequence([Animated.timing(o, { toValue: 0.25, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }), Animated.timing(o, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true })]));
    a.start();
    return () => a.stop();
  }, [st.pulse, reduce, o]);
  return (
    <View style={{ borderRadius: 999, overflow: 'hidden', alignSelf: 'flex-start' }}>
      <LinearGradient colors={st.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, paddingHorizontal: 10 }}>
        <Animated.View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: '#fff', opacity: st.pulse ? o : 1 }} />
        <AT size={10.5} weight="900" color="#fff" style={{ letterSpacing: 1.1 }}>{label ?? st.label}</AT>
      </LinearGradient>
    </View>
  );
}

const crest = (t, size = 44) => (
  <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: t?.color ?? A.panel2, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)' }}>
    <Text style={{ fontSize: size * 0.5 }}>{t?.emoji ?? '🛡️'}</Text>
  </View>
);

function Pop({ value, size = 44, color = A.ink }) {
  const sc = useRef(new Animated.Value(1)).current;
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== value) { prev.current = value; sc.setValue(1.35); Animated.spring(sc, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 14 }).start(); }
  }, [value, sc]);
  return <Animated.View style={{ transform: [{ scale: sc }] }}><AT size={size} weight="900" num color={color} style={{ textShadowColor: `${color}88`, textShadowRadius: 14 }}>{value ?? 0}</AT></Animated.View>;
}

export const phaseText = (g) => {
  const rs = g.ruleset, sc = g.score, ph = g.phase;
  if (g.fixture.status === 'scheduled') return null;
  if (rs?.kind === 'sets') return sc.over ? `${sc.sets.map((s) => `${s.home}–${s.away}`).join('  ')}` : `Set ${sc.sets.length + 1} · ${sc.current_set?.home ?? 0}–${sc.current_set?.away ?? 0}${sc.sets.length ? `   (${sc.sets.map((s) => `${s.home}–${s.away}`).join(', ')})` : ''}`;
  if (rs?.kind === 'points_events' && ph.period) return `${rs.periods.label} ${ph.period}${ph.period_open ? '' : ' · break'}`;
  return null;
};

/** The scoreboard: crests, names and glowing numbers that pop when the score changes. g = a live state. */
export function ScoreTicker({ g, onPress, compact }) {
  const f = g.fixture, sc = g.score;
  const final = f.final ?? null;
  const home = final ? final.home : sc.home, away = final ? final.away : sc.away;
  const body = (
    <View style={{ backgroundColor: A.panel, borderRadius: 24, borderWidth: 1, borderColor: f.status === 'live' ? `${A.red}88` : A.line, padding: compact ? 14 : 18, ...(f.status === 'live' ? glow(A.red, 0.3, 18) : null) }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <LiveBadge status={f.status} />
        <AT size={11.5} weight="700" color={A.mute}>{g.ruleset?.label}{f.round ? ` · ${f.round}` : ''}</AT>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 14 }}>
        <View style={{ flex: 1, alignItems: 'center', gap: 6 }}>{crest(f.home, compact ? 40 : 52)}<AT size={13} weight="800" numberOfLines={2} style={{ textAlign: 'center' }}>{f.home?.name ?? 'TBD'}</AT></View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6 }}>
          <Pop value={home} size={compact ? 38 : 52} /><AT size={24} weight="900" color={A.mute}>:</AT><Pop value={away} size={compact ? 38 : 52} />
        </View>
        <View style={{ flex: 1, alignItems: 'center', gap: 6 }}>{crest(f.away, compact ? 40 : 52)}<AT size={13} weight="800" numberOfLines={2} style={{ textAlign: 'center' }}>{f.away?.name ?? 'TBD'}</AT></View>
      </View>
      {phaseText(g) ? <AT size={12.5} weight="700" color={A.cyan} style={{ textAlign: 'center', marginTop: 12 }}>{phaseText(g)}</AT> : null}
      {f.event_status === 'paused' && f.pause_reason ? <AT size={12} weight="700" color={A.sun} style={{ textAlign: 'center', marginTop: 8 }}>⏸ {f.pause_reason}</AT> : null}
    </View>
  );
  return onPress ? <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1, transform: [{ scale: pressed ? 0.99 : 1 }] })}>{body}</Pressable> : body;
}

/** Horizontal progress rail: [{ key, label, state: 'done' | 'now' | 'todo' }]. */
export function StageRail({ steps }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center', gap: 6, paddingVertical: 4 }}>
      {steps.map((s, i) => (
        <React.Fragment key={s.key}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingVertical: 6, paddingHorizontal: 12, backgroundColor: s.state === 'now' ? `${A.magenta}33` : s.state === 'done' ? `${A.green}22` : A.panel, borderWidth: 1.5, borderColor: s.state === 'now' ? A.magenta : s.state === 'done' ? `${A.green}66` : A.line }}>
            <AT size={12} weight="900" color={s.state === 'done' ? A.green : s.state === 'now' ? '#fff' : A.mute}>{s.state === 'done' ? '✓' : i + 1}</AT>
            <AT size={12} weight="800" color={s.state === 'todo' ? A.mute : '#fff'}>{s.label}</AT>
          </View>
          {i < steps.length - 1 ? <View style={{ width: 14, height: 2, borderRadius: 1, backgroundColor: s.state === 'done' ? A.green : A.line }} /> : null}
        </React.Fragment>
      ))}
    </ScrollView>
  );
}

export const DeptChip = ({ dept, active, onPress, count }) => (
  <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14, minHeight: 40, borderWidth: 1.5, borderColor: active ? dept.colour : A.line, backgroundColor: active ? `${dept.colour}33` : A.panel })}>
    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dept.colour }} />
    <AT size={13} weight="800" color={active ? '#fff' : A.mute}>{dept.name}</AT>
    {count != null ? <AT size={12} weight="800" color={A.mute}>{count}</AT> : null}
  </Pressable>
);

export function AAvatar({ user, size = 28, ring = A.panel }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: user?.avatar_color ?? A.violet, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: ring }}>
      <Text style={{ fontSize: size * 0.5 }}>{user?.avatar_emoji ?? '😎'}</Text>
    </View>
  );
}

export function PodiumCard({ places }) {
  const medal = ['🥇', '🥈', '🥉'], tone = [AG.sun, ['#CBD5E1', '#94A3B8'], ['#FB923C', '#B45309']];
  return (
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-end' }}>
      {[1, 0, 2].map((i) => places[i] ? (
        <View key={i} style={{ flex: 1, borderRadius: 20, overflow: 'hidden' }}>
          <LinearGradient colors={tone[i]} style={{ padding: 12, alignItems: 'center', paddingTop: i === 0 ? 26 : 16, gap: 4 }}>
            <Text style={{ fontSize: 30 }}>{medal[i]}</Text>
            <AT size={13} weight="900" color="#0A0716" numberOfLines={2} style={{ textAlign: 'center' }}>{places[i].name}</AT>
            {places[i].note ? <AT size={11} weight="800" color="rgba(10,7,22,0.65)">{places[i].note}</AT> : null}
          </LinearGradient>
        </View>
      ) : <View key={i} style={{ flex: 1 }} />)}
    </View>
  );
}

/** Ask "why?" with quick reason chips plus an optional note, then confirm. Used for pause, end, reject, void. */
export function ReasonSheet({ visible, onClose, title, sub, presets = [], confirmLabel = 'Confirm', tone = 'live', requireReason = true, onConfirm }) {
  const [pick, setPick] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (visible) { setPick(null); setNote(''); } }, [visible]);
  const text = [pick, note.trim()].filter(Boolean).join(': ');
  const go = async () => { setBusy(true); try { await onConfirm(text); onClose(); } finally { setBusy(false); } };
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      {sub ? <AT size={13} color={A.mute}>{sub}</AT> : null}
      {presets.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{presets.map((p) => <AChip key={p} label={p} active={pick === p} onPress={() => setPick(pick === p ? null : p)} />)}</View> : null}
      <Field label="Add a note (optional)" value={note} onChangeText={setNote} multiline />
      <ABtn title={confirmLabel} tone={tone} onPress={go} loading={busy} disabled={requireReason && !text} />
    </Sheet>
  );
}

/** Big − / + stepper for whole numbers such as a final score. */
export function AStepper({ label, value, onChange, min = 0, max = 999, color = A.violet }) {
  const btn = (txt, d) => (
    <Pressable onPress={() => onChange(Math.min(max, Math.max(min, (value ?? 0) + d)))} accessibilityRole="button" accessibilityLabel={`${label} ${d > 0 ? 'plus' : 'minus'}`}
      style={({ pressed }) => ({ width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: `${color}33`, borderWidth: 1.5, borderColor: color, opacity: pressed ? 0.7 : 1 })}>
      <AT size={22} weight="900" color="#fff">{txt}</AT>
    </Pressable>
  );
  return (
    <View style={{ alignItems: 'center', gap: 8, flex: 1 }}>
      <AT size={12} weight="800" color={A.mute} numberOfLines={1}>{String(label).toUpperCase()}</AT>
      <AT size={46} weight="900" num style={{ textShadowColor: `${color}99`, textShadowRadius: 14 }}>{value ?? '–'}</AT>
      <View style={{ flexDirection: 'row', gap: 12 }}>{btn('−', -1)}{btn('+', 1)}</View>
    </View>
  );
}
