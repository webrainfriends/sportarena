import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { c, grad, r, accentFor, fam } from './theme';

const lift = Platform.OS === 'web'
  ? { boxShadow: '0 1px 2px rgba(11,20,38,0.05), 0 6px 16px rgba(11,20,38,0.05)' }
  : { shadowColor: '#0B1426', shadowOpacity: 0.07, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 2 };

/** Surface: white, hairline border, soft lift. */
export function Card({ children, color = c.paper, style, onPress, pad = 16 }) {
  const body = <View style={[s.card, { backgroundColor: color, padding: pad }]}>{children}</View>;
  return onPress
    ? <Pressable onPress={onPress} style={({ pressed }) => [style, pressed ? { opacity: 0.88 } : null]}>{body}</Pressable>
    : <View style={style}>{body}</View>;
}

export function GradCard({ children, colors = grad.hero, style, pad = 20, onPress }) {
  const body = (
    <View style={[s.gradWrap, onPress ? null : style]}>
      <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ padding: pad }}>{children}</LinearGradient>
    </View>
  );
  return onPress ? <Pressable onPress={onPress} style={style}>{body}</Pressable> : body;
}

export const T = ({ children, style, size = 15, color = c.ink, weight = '500', ...p }) => <Text {...p} style={[fam, { fontSize: size, color, fontWeight: normW(weight) }, style]}>{children}</Text>;
export const H1 = ({ children, color = c.ink, style }) => <Text style={[fam, { fontSize: 32, fontWeight: '800', color, letterSpacing: -0.8 }, style]}>{children}</Text>;
export const H2 = ({ children, color = c.ink, style }) => <Text style={[fam, { fontSize: 19, fontWeight: '700', color, letterSpacing: -0.3 }, style]}>{children}</Text>;
/** Screens were authored with heavy weights; map them onto a calmer scale. */
function normW(w) { return w === '900' ? '700' : w === '800' ? '600' : w; }

export function Section({ title, action, onAction, children, color = c.pink }) {
  return (
    <View style={{ marginTop: 28 }}>
      <View style={s.secRow}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 }}>
          <View style={{ width: 4, height: 18, borderRadius: 2, backgroundColor: color === c.pink ? c.pink : color }} />
          <H2>{title}</H2>
        </View>
        {action ? <Pressable onPress={onAction}><T weight="700" size={13} color={c.pink}>{action}  ›</T></Pressable> : null}
      </View>
      <View style={{ gap: 10, marginTop: 12 }}>{children}</View>
    </View>
  );
}

export function Btn({ title, onPress, color = c.pink, ink = '#fff', style, small, disabled, loading, emoji }) {
  const light = color === c.lime || color === c.sun || color === c.cyan || color === c.mint;
  const fg = ink === '#fff' && light ? c.ink : ink;
  return (
    <Pressable disabled={disabled || loading} onPress={onPress}
      style={({ pressed }) => [{ opacity: disabled ? 0.45 : pressed ? 0.85 : 1 }, style]}>
      <View style={[s.btn, { backgroundColor: color, paddingVertical: small ? 8 : 14, paddingHorizontal: small ? 14 : 22 }]}>
        {loading ? <ActivityIndicator color={fg} /> : <T weight="700" size={small ? 13 : 15} color={fg} style={{ letterSpacing: 0.2 }}>{title}</T>}
      </View>
    </Pressable>
  );
}

export function Chip({ label, active, onPress, color = c.violet }) {
  const dark = !(color === c.lime || color === c.sun || color === c.cyan || color === c.mint);
  return (
    <Pressable onPress={onPress} style={[s.chip, active ? { backgroundColor: color, borderColor: color } : null]}>
      <T weight="600" size={13} color={active ? (dark ? '#fff' : c.ink) : c.mute}>{label}</T>
    </Pressable>
  );
}

export const Tag = ({ label, color = c.violetSoft, ink = c.violet, style }) => (
  <View style={[s.tag, { backgroundColor: color }, style]}><T weight="700" size={10.5} color={ink} style={{ letterSpacing: 0.8 }}>{String(label).toUpperCase()}</T></View>
);

export function Avatar({ user, size = 44, emoji, color }) {
  const bg = color ?? user?.avatar_color ?? accentFor(user?.handle);
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, borderWidth: 2, borderColor: '#fff', alignItems: 'center', justifyContent: 'center', ...lift }}>
      <Text style={{ fontSize: size * 0.5 }}>{emoji ?? user?.avatar_emoji ?? '😎'}</Text>
    </View>
  );
}

export function Row({ left, title, sub, right, onPress, color = c.paper }) {
  return (
    <Card onPress={onPress} color={color} pad={12}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {left}
        <View style={{ flex: 1 }}>
          <T weight="700" size={15}>{title}</T>
          {sub ? <T size={13} color={c.mute} style={{ marginTop: 2 }}>{sub}</T> : null}
        </View>
        {right}
      </View>
    </Card>
  );
}

export const Bubble = ({ emoji, color = c.sun, size = 46 }) => (
  <View style={{ width: size, height: size, borderRadius: 12, backgroundColor: color === c.sun || color === c.paper ? c.violetSoft : color, alignItems: 'center', justifyContent: 'center' }}>
    <Text style={{ fontSize: size * 0.5 }}>{emoji}</Text>
  </View>
);

export function Field({ label, value, onChangeText, secure, multiline, keyboardType, placeholder, hint }) {
  const [focus, setFocus] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      {label ? <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{label.toUpperCase()}</T> : null}
      <TextInput value={value ?? ''} onChangeText={onChangeText} secureTextEntry={secure} multiline={multiline} keyboardType={keyboardType} placeholder={placeholder}
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        autoCapitalize="none" placeholderTextColor="#9AA4B8" style={[fam, s.input, focus && { borderColor: c.pink, backgroundColor: '#fff' }, multiline && { minHeight: 80, textAlignVertical: 'top' }, Platform.OS === 'web' && { outlineStyle: 'none' }]} />
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
    </View>
  );
}

export const Seg = ({ options, value, onChange, color = c.violet }) => (
  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4, paddingRight: 8 }}>
    {options.map((o) => <Chip key={o.value ?? o} label={o.label ?? o} emoji={o.emoji} active={(o.value ?? o) === value} onPress={() => onChange(o.value ?? o)} color={o.color ?? color} />)}
  </ScrollView>
);

export function Screen({ children, scroll = true, refreshing, onRefresh, padBottom = 28, style }) {
  const Inner = scroll ? ScrollView : View;
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Inner style={{ flex: 1 }} contentContainerStyle={scroll ? { padding: 16, paddingBottom: padBottom, maxWidth: 720, width: '100%', alignSelf: 'center' } : undefined} showsVerticalScrollIndicator={false}>
        {scroll ? children : <View style={[{ flex: 1, padding: 16 }, style]}>{children}</View>}
      </Inner>
    </View>
  );
}

export function Loading({ label = 'Loading…' }) {
  const y = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.sequence([
      Animated.timing(y, { toValue: -10, duration: 350, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(y, { toValue: 0, duration: 350, easing: Easing.in(Easing.quad), useNativeDriver: true })]));
    a.start();
    return () => a.stop();
  }, [y]);
  return <View style={{ alignItems: 'center', padding: 40 }}><Animated.Text style={{ fontSize: 36, transform: [{ translateY: y }] }}>⚽</Animated.Text><T color={c.mute} weight="600" size={13}>{label}</T></View>;
}

export const Empty = ({ emoji = '🫥', title, sub }) => (
  <Card color={c.paper} style={{ alignSelf: 'stretch' }}>
    <View style={{ alignItems: 'center', gap: 4, paddingVertical: 8 }}>
      <Text style={{ fontSize: 32 }}>{emoji}</Text><T weight="700" size={15}>{title}</T>{sub ? <T size={13} color={c.mute} style={{ textAlign: 'center' }}>{sub}</T> : null}
    </View>
  </Card>
);

export const ErrorBox = ({ error, onRetry }) => (
  <Card color={c.orangeSoft}><T weight="700">{error?.message ?? 'Something went wrong'}</T>{onRetry ? <Btn small title="Try again" onPress={onRetry} style={{ marginTop: 10, alignSelf: 'flex-start' }} color={c.ink} /> : null}</Card>
);

/** Bottom sheet modal with a form body. */
export function Sheet({ visible, onClose, title, children }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.scrim}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={s.sheet}>
          <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: c.line, marginTop: 10 }} />
          <ScrollView contentContainerStyle={{ padding: 18, gap: 14 }} keyboardShouldPersistTaps="handled">
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><H2>{title}</H2><Pressable onPress={onClose} hitSlop={12}><T size={22} color={c.mute}>✕</T></Pressable></View>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export function StatPill({ value, label, color = c.sun }) {
  const onDark = color === c.lime || color === c.sun || color === c.cyan || color === c.mint;
  return (
    <View style={[s.stat, { backgroundColor: onDark ? color : c.paper }]}>
      <T weight="800" size={22} style={{ letterSpacing: -0.5 }}>{value}</T>
      <T weight="600" size={10} color={onDark ? c.ink : c.mute} style={{ letterSpacing: 0.8, opacity: 0.75 }}>{label}</T>
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderWidth: 1, borderColor: c.line, borderRadius: r.card, ...lift },
  gradWrap: { borderRadius: r.card + 4, overflow: 'hidden' },
  btn: { borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  chip: { borderWidth: 1, borderColor: c.line, backgroundColor: c.paper, borderRadius: r.pill, paddingVertical: 8, paddingHorizontal: 15 },
  tag: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  input: { borderWidth: 1.5, borderColor: c.line, borderRadius: r.input, backgroundColor: '#F8F9FC', paddingHorizontal: 14, paddingVertical: 13, fontSize: 15, fontWeight: '500', color: c.ink },
  secRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  scrim: { flex: 1, backgroundColor: 'rgba(11,20,38,0.55)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '88%', overflow: 'hidden', width: '100%', maxWidth: 720, alignSelf: 'center' },
  stat: { borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', minWidth: 78 },
});
