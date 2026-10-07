import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { c, grad, r, softOf, accentFor } from './theme';

const SH = 4; // hard-shadow offset

/** A sticker: ink outline + offset ink shadow (works the same on iOS, Android and web). */
export function Card({ children, color = c.paper, style, onPress, pad = 16, tilt = 0 }) {
  const layout = [tilt ? { transform: [{ rotate: `${tilt}deg` }] } : null, style];
  const body = (
    <View style={{ paddingRight: SH, paddingBottom: SH }}>
      <View style={[s.shadow, { borderRadius: r.card }]} />
      <View style={[s.card, { backgroundColor: color, padding: pad }]}>{children}</View>
    </View>
  );
  return onPress
    ? <Pressable onPress={onPress} style={({ pressed }) => [layout, pressed ? { opacity: 0.85 } : null]}>{body}</Pressable>
    : <View style={layout}>{body}</View>;
}

export function GradCard({ children, colors = grad.hero, style, pad = 18, onPress }) {
  const body = (
    <View style={[{ paddingRight: SH, paddingBottom: SH }, onPress ? null : style]}>
      <View style={[s.shadow, { borderRadius: r.card + 2 }]} />
      <View style={s.gradWrap}>
        <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ padding: pad }}>{children}</LinearGradient>
      </View>
    </View>
  );
  return onPress ? <Pressable onPress={onPress} style={style}>{body}</Pressable> : body;
}

export const T = ({ children, style, size = 15, color = c.ink, weight = '600', ...p }) => <Text {...p} style={[{ fontSize: size, color, fontWeight: weight }, style]}>{children}</Text>;
export const H1 = ({ children, color = c.ink, style }) => <Text style={[{ fontSize: 34, fontWeight: '900', color, letterSpacing: -1 }, style]}>{children}</Text>;
export const H2 = ({ children, color = c.ink, style }) => <Text style={[{ fontSize: 22, fontWeight: '900', color, letterSpacing: -0.5 }, style]}>{children}</Text>;

export function Section({ title, emoji, action, onAction, children, color = c.sun }) {
  return (
    <View style={{ marginTop: 22 }}>
      <View style={s.secRow}>
        <View style={{ flexShrink: 1 }}>
          <View style={[s.hl, { backgroundColor: color }]} />
          <H2>{emoji ? `${emoji} ` : ''}{title}</H2>
        </View>
        {action ? <Pressable onPress={onAction}><T weight="800" color={c.violet}>{action} →</T></Pressable> : null}
      </View>
      <View style={{ gap: 12, marginTop: 10 }}>{children}</View>
    </View>
  );
}

export function Btn({ title, onPress, color = c.pink, ink = '#fff', style, small, disabled, loading, emoji }) {
  const [down, setDown] = useState(false);
  return (
    <Pressable disabled={disabled || loading} onPress={onPress} onPressIn={() => setDown(true)} onPressOut={() => setDown(false)}
      style={[{ paddingRight: 3, paddingBottom: 3, opacity: disabled ? 0.5 : 1 }, style]}>
      <View style={[s.shadow, { borderRadius: r.pill, left: 3, top: 3 }]} />
      <View style={[s.btn, { backgroundColor: color, paddingVertical: small ? 8 : 14, paddingHorizontal: small ? 14 : 22, transform: down ? [{ translateX: 2 }, { translateY: 2 }] : [] }]}>
        {loading ? <ActivityIndicator color={ink} /> : <T weight="900" size={small ? 13 : 16} color={ink}>{emoji ? `${emoji}  ` : ''}{title}</T>}
      </View>
    </Pressable>
  );
}

export function Chip({ label, active, onPress, color = c.violet, emoji }) {
  return (
    <Pressable onPress={onPress} style={[s.chip, { backgroundColor: active ? color : c.paper }]}>
      <T weight="800" size={13} color={active ? (color === c.lime || color === c.sun || color === c.cyan || color === c.mint ? c.ink : '#fff') : c.ink}>{emoji ? `${emoji} ` : ''}{label}</T>
    </Pressable>
  );
}

export const Tag = ({ label, color = c.lime, ink = c.ink, style }) => (
  <View style={[s.tag, { backgroundColor: color }, style]}><T weight="900" size={11} color={ink}>{String(label).toUpperCase()}</T></View>
);

export function Avatar({ user, size = 44, emoji, color }) {
  const bg = color ?? user?.avatar_color ?? accentFor(user?.handle);
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, borderWidth: 2.5, borderColor: c.ink, alignItems: 'center', justifyContent: 'center' }}>
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
          <T weight="900" size={16}>{title}</T>
          {sub ? <T size={13} color={c.mute} style={{ marginTop: 2 }}>{sub}</T> : null}
        </View>
        {right}
      </View>
    </Card>
  );
}

export const Bubble = ({ emoji, color = c.sun, size = 48 }) => (
  <View style={{ width: size, height: size, borderRadius: size * 0.34, backgroundColor: color, borderWidth: 2.5, borderColor: c.ink, alignItems: 'center', justifyContent: 'center' }}>
    <Text style={{ fontSize: size * 0.52 }}>{emoji}</Text>
  </View>
);

export function Field({ label, value, onChangeText, secure, multiline, keyboardType, placeholder, hint }) {
  return (
    <View style={{ gap: 6 }}>
      {label ? <T weight="800" size={13}>{label}</T> : null}
      <TextInput value={value ?? ''} onChangeText={onChangeText} secureTextEntry={secure} multiline={multiline} keyboardType={keyboardType} placeholder={placeholder}
        autoCapitalize="none" placeholderTextColor="#A79FBE" style={[s.input, multiline && { minHeight: 80, textAlignVertical: 'top' }, Platform.OS === 'web' && { outlineStyle: 'none' }]} />
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
    </View>
  );
}

export const Seg = ({ options, value, onChange, color = c.violet }) => (
  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4, paddingRight: 8 }}>
    {options.map((o) => <Chip key={o.value ?? o} label={o.label ?? o} emoji={o.emoji} active={(o.value ?? o) === value} onPress={() => onChange(o.value ?? o)} color={o.color ?? color} />)}
  </ScrollView>
);

/** Backdrop of loud blobs + confetti so every screen feels like a poster. */
function Blobs() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[s.blob, { top: -90, right: -70, width: 260, height: 260, backgroundColor: "#FFB3DA" }]} />
      <View style={[s.blob, { top: 220, left: -110, width: 240, height: 240, backgroundColor: "#A8EEFF" }]} />
      <View style={[s.blob, { bottom: 80, right: -90, width: 240, height: 240, backgroundColor: "#DDFF8A" }]} />
      <View style={[s.blob, { bottom: -60, left: -40, width: 180, height: 180, backgroundColor: "#FFE27A" }]} />
    </View>
  );
}

export function Screen({ children, scroll = true, refreshing, onRefresh, padBottom = 24, style }) {
  const Inner = scroll ? ScrollView : View;
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Blobs />
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
      Animated.timing(y, { toValue: -14, duration: 350, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(y, { toValue: 0, duration: 350, easing: Easing.in(Easing.quad), useNativeDriver: true })]));
    a.start();
    return () => a.stop();
  }, [y]);
  return <View style={{ alignItems: 'center', padding: 40 }}><Animated.Text style={{ fontSize: 44, transform: [{ translateY: y }] }}>⚽</Animated.Text><T color={c.mute} weight="800">{label}</T></View>;
}

export const Empty = ({ emoji = '🫥', title, sub }) => (
  <Card color={c.paper} style={{ alignSelf: 'stretch' }}>
    <View style={{ alignItems: 'center', gap: 4, paddingVertical: 8 }}>
      <Text style={{ fontSize: 40 }}>{emoji}</Text><T weight="900" size={16}>{title}</T>{sub ? <T size={13} color={c.mute} style={{ textAlign: 'center' }}>{sub}</T> : null}
    </View>
  </Card>
);

export const ErrorBox = ({ error, onRetry }) => (
  <Card color={c.pinkSoft}><T weight="900">😵 {error?.message ?? 'Something went wrong'}</T>{onRetry ? <Btn small title="Try again" onPress={onRetry} style={{ marginTop: 10, alignSelf: 'flex-start' }} color={c.ink} /> : null}</Card>
);

/** Bottom sheet modal with a form body. */
export function Sheet({ visible, onClose, title, children }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.scrim}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
        <View style={s.sheet}>
          <LinearGradient colors={grad.hero} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ height: 8 }} />
          <ScrollView contentContainerStyle={{ padding: 18, gap: 14 }} keyboardShouldPersistTaps="handled">
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><H2>{title}</H2><Pressable onPress={onClose}><T size={26}>✖️</T></Pressable></View>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export function StatPill({ value, label, color = c.sun }) {
  return (
    <View style={[s.stat, { backgroundColor: color }]}>
      <T weight="900" size={22}>{value}</T>
      <T weight="800" size={11}>{label}</T>
    </View>
  );
}

const s = StyleSheet.create({
  shadow: { position: 'absolute', left: SH, top: SH, right: 0, bottom: 0, backgroundColor: c.ink },
  card: { borderWidth: 2.5, borderColor: c.ink, borderRadius: r.card },
  gradWrap: { borderWidth: 2.5, borderColor: c.ink, borderRadius: r.card, overflow: 'hidden' },
  btn: { borderWidth: 2.5, borderColor: c.ink, borderRadius: r.pill, alignItems: 'center', justifyContent: 'center' },
  chip: { borderWidth: 2.5, borderColor: c.ink, borderRadius: r.pill, paddingVertical: 7, paddingHorizontal: 14 },
  tag: { borderWidth: 2, borderColor: c.ink, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2, alignSelf: 'flex-start' },
  input: { borderWidth: 2.5, borderColor: c.ink, borderRadius: r.input, backgroundColor: '#fff', paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, fontWeight: '600', color: c.ink },
  secRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  hl: { position: 'absolute', left: -4, bottom: 2, height: 12, width: '70%', borderRadius: 6, opacity: 0.9 },
  blob: { position: 'absolute', borderRadius: 999, opacity: 0.85 },
  scrim: { flex: 1, backgroundColor: 'rgba(27,16,53,0.55)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.bg, borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: 2.5, borderBottomWidth: 0, borderColor: c.ink, maxHeight: '88%', overflow: 'hidden', width: '100%', maxWidth: 720, alignSelf: 'center' },
  stat: { borderWidth: 2.5, borderColor: c.ink, borderRadius: 18, paddingVertical: 8, paddingHorizontal: 14, alignItems: 'center', minWidth: 78 },
});
