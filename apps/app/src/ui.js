import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, FlatList, Image, Keyboard, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { c, dark, grad, r, accentFor, fam } from './theme';
import { useLayout } from './layout';
import { mediaUrl } from './api';
import { t } from './i18n';
import { Icon } from './icons';
import { tapped } from './haptics';
// The native animation driver does not exist on the web; asking for it logs a warning and falls back to JS anyway.
const NATIVE = Platform.OS !== 'web';

const EMOJI = /\s*(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]\uFE0F?\u200d?)+\s*$/u;
const plain = (ch) => (typeof ch === 'string' ? ch.replace(EMOJI, '') : Array.isArray(ch) ? ch.map(plain) : ch);
/** Soft pastel fills collapse to a plain surface — only the warning tint survives. */
const surface = (col) => (col === c.orangeSoft ? col : c.paper);

const lift = Platform.OS === 'web'
  ? { boxShadow: '0 1px 2px rgba(15,23,42,0.04), 0 6px 20px rgba(15,23,42,0.06)' }
  : { shadowColor: '#0F172A', shadowOpacity: 0.07, shadowRadius: 14, shadowOffset: { width: 0, height: 4 }, elevation: 2 };

/** Surface: white, hairline border, soft lift. */
export function Card({ children, color = c.paper, style, onPress, pad = 16, accessibilityLabel }) {
  const body = <View style={[s.card, { backgroundColor: surface(color), padding: pad }]}>{children}</View>;
  return onPress
    ? <Pressable onPress={tapped(onPress)} accessibilityRole="button" accessibilityLabel={accessibilityLabel} style={({ pressed }) => [style, pressed ? { opacity: 0.92, transform: [{ scale: 0.985 }] } : null]}>{body}</Pressable>
    : <View style={style}>{body}</View>;
}

export function GradCard({ children, colors = grad.hero, style, pad = 22, onPress }) {
  if (!Object.values(grad).includes(colors)) colors = grad.hero;
  const body = (
    <View style={[s.gradWrap, onPress ? null : style]}>
      <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ padding: pad }}>
        <View pointerEvents="none" style={{ position: 'absolute', right: -40, top: -60, width: 190, height: 190, borderRadius: 95, backgroundColor: '#fff', opacity: 0.12 }} />
        <View pointerEvents="none" style={{ position: 'absolute', right: 70, bottom: -70, width: 120, height: 120, borderRadius: 60, backgroundColor: '#fff', opacity: 0.08 }} />
        {children}
      </LinearGradient>
    </View>
  );
  return onPress ? <Pressable onPress={tapped(onPress)} style={style}>{body}</Pressable> : body;
}

export const T = ({ children, style, size = 15, color = c.ink, weight = '500', ...p }) => <Text {...p} style={[fam, { fontSize: size, color, fontWeight: normW(weight) }, style]}>{children}</Text>;
export const H1 = ({ children, color = c.ink, style }) => <Text style={[fam, { fontSize: 32, fontWeight: '800', color, letterSpacing: -1.2 }, style]}>{plain(children)}</Text>;
export const H2 = ({ children, color = c.ink, style }) => <Text style={[fam, { fontSize: 19, fontWeight: '700', color, letterSpacing: -0.3 }, style]}>{plain(children)}</Text>;
/** Screens were authored with heavy weights; map them onto a calmer scale. */
function normW(w) { return w === '900' ? '700' : w === '800' ? '600' : w; }

export function Section({ title, action, onAction, children, color = c.pink }) {
  return (
    <View style={{ marginTop: 28 }}>
      <View style={s.secRow}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 }}>
          <H2>{title}</H2>
        </View>
        {action ? <Pressable onPress={tapped(onAction)}><T weight="700" size={13} color={c.pink}>{action}  ›</T></Pressable> : null}
      </View>
      <View style={{ gap: 10, marginTop: 12 }}>{children}</View>
    </View>
  );
}

export function Btn({ title, onPress, color: want = c.pink, ink = '#fff', style, small, disabled, loading, accessibilityLabel }) {
  const color = want === c.cyan || want === c.mint || want === c.sun || want === c.ink || want === c.lime ? c.violet : want === c.orange ? c.pink : want;
  const plain = color === c.paper;
  const fg = plain ? (ink === '#fff' ? c.ink : ink) : color === c.pink ? c.onAccent : '#fff';
  return (
    <Pressable disabled={disabled || loading} onPress={tapped(onPress)} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      hitSlop={small ? 4 : 0} style={({ pressed }) => [{ opacity: disabled ? 0.4 : pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }, style]}>
      <View style={[s.btn, { backgroundColor: color, borderWidth: plain ? 1 : 0, borderColor: c.line, paddingVertical: small ? 10 : 15, paddingHorizontal: small ? 18 : 24, minHeight: small ? 44 : 50 }]}>
        {loading ? <ActivityIndicator color={fg} /> : <T weight="700" size={small ? 13 : 15} color={fg} style={{ letterSpacing: 0.2 }}>{title}</T>}
      </View>
    </Pressable>
  );
}

export function Chip({ label, active, onPress }) {
  return (
    <Pressable onPress={tapped(onPress)} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!active }} hitSlop={6} style={[s.chip, active ? { backgroundColor: c.ink, borderColor: c.ink } : null]}>
      <T weight="600" size={13} color={active ? c.inkOn : c.mute}>{label}</T>
    </Pressable>
  );
}

const TAG = { [c.sun]: [c.sunSoft, dark ? c.sun : '#9A6400'], [c.cyan]: [c.cyanSoft, c.cyan], [c.mint]: [c.mintSoft, c.mint], [c.orange]: [c.pinkSoft, c.pink], [c.pinkSoft]: [c.pinkSoft, c.pink], [c.violetSoft]: [c.violetSoft, c.mute], [c.ink]: [c.ink, c.inkOn], [c.red]: [c.red, '#fff'] };
export const Tag = ({ label, color = c.violetSoft, style }) => {
  const [bg, fg] = TAG[color] ?? [c.violetSoft, c.mute];
  return <View style={[s.tag, { backgroundColor: bg }, style]}><T weight="700" size={10.5} color={fg} style={{ letterSpacing: 0.9 }}>{String(label).toUpperCase()}</T></View>;
};

export function Avatar({ user, size = 44, emoji, color }) {
  const bg = color ?? user?.avatar_color ?? accentFor(user?.handle);
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, borderWidth: 2, borderColor: c.paper, alignItems: 'center', justifyContent: 'center', ...lift }}>
      {user?.avatar_url && !emoji
        ? <Image source={{ uri: mediaUrl(user.avatar_url) }} accessibilityLabel={`${user.display_name ?? 'Profile'} photo`} style={{ width: size - 4, height: size - 4, borderRadius: (size - 4) / 2 }} />
        : <Text style={{ fontSize: size * 0.5 }}>{emoji ?? user?.avatar_emoji ?? '😎'}</Text>}
    </View>
  );
}

export function Row({ left, title, sub, right, onPress, color = c.paper }) {
  return (
    <Card onPress={onPress} color={color} pad={12} accessibilityLabel={onPress ? [title, sub].filter((x) => typeof x === 'string').join('. ') : undefined}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {left}
        <View style={{ flex: 1 }}>
          <T weight="700" size={15}>{title}</T>
          {sub ? <T size={13} color={c.mute} style={{ marginTop: 2 }}>{sub}</T> : null}
        </View>
        {right ? <View style={{ alignSelf: 'center', alignItems: 'flex-end' }}>{right}</View> : null}
      </View>
    </Card>
  );
}

export const Bubble = ({ emoji, color = c.sun, size = 46 }) => (
  <View style={{ width: size, height: size, borderRadius: 14, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}>
    <Text style={{ fontSize: size * 0.5 }}>{emoji}</Text>
  </View>
);

export function Field({ label, value, onChangeText, secure, multiline, keyboardType, placeholder, hint, maxLength, accessibilityLabel, minHeight, rtl }) {
  const [focus, setFocus] = useState(false);
  const [reveal, setReveal] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      {label ? <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{label.toUpperCase()}</T> : null}
      <View>
        <TextInput value={value ?? ''} onChangeText={onChangeText} accessibilityLabel={accessibilityLabel ?? label ?? placeholder} maxLength={maxLength} secureTextEntry={secure && !reveal} multiline={multiline} keyboardType={keyboardType} placeholder={placeholder}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          autoCapitalize="none" placeholderTextColor={c.mute} style={[fam, s.input, focus && { borderColor: c.ink }, multiline && { minHeight: minHeight ?? 80, textAlignVertical: 'top' }, rtl && { textAlign: 'right', writingDirection: 'rtl' }, secure && { paddingEnd: 52 }, Platform.OS === 'web' && { outlineStyle: 'none' }]} />
        {secure ? (
          <Pressable onPress={() => setReveal((x) => !x)} accessibilityRole="button" accessibilityLabel={reveal ? t('auth.hide_password') : t('auth.show_password')} accessibilityState={{ selected: reveal }}
            hitSlop={4} style={{ position: 'absolute', end: 0, top: 0, bottom: 0, width: 48, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={reveal ? 'EyeOff' : 'Eye'} size={22} color={c.mute} />
          </Pressable>
        ) : null}
      </View>
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
    </View>
  );
}

// an option is a plain value or { value, label }; `value: null` is a real choice (e.g. "All"), so test for the key, not for null
const optValue = (o) => (o !== null && typeof o === 'object' && 'value' in o ? o.value : o);
/** Horizontal scroller with ◀ ▶ buttons, so every chip is reachable without a trackpad or touch. */
export function HScroll({ children, gap = 8, style }) {
  const ref = useRef(null);
  const m = useRef({ x: 0, w: 0, cw: 0 });
  const [edge, setEdge] = useState({ left: false, right: false });
  // Scroll events fire many times a second; only re-render when an arrow actually appears or disappears.
  const measure = (patch) => {
    m.current = { ...m.current, ...patch };
    const { x, w, cw } = m.current;
    const left = x > 4, right = cw - w - x > 4;
    setEdge((p) => (p.left === left && p.right === right ? p : { left, right }));
  };
  const by = (dir) => ref.current?.scrollTo?.({ x: Math.max(0, m.current.x + dir * Math.max(160, m.current.w * 0.7)), animated: true });
  const arrow = (dir, show) => (show ? (
    <Pressable key={dir} onPress={() => by(dir)} accessibilityRole="button" accessibilityLabel={dir < 0 ? 'Scroll left' : 'Scroll right'}
      style={{ position: 'absolute', top: 0, bottom: 0, [dir < 0 ? 'left' : 'right']: 0, width: 34, alignItems: dir < 0 ? 'flex-start' : 'flex-end', justifyContent: 'center', zIndex: 2 }}>
      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center', shadowColor: '#0F172A', shadowOpacity: 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } }}>
        <T weight="800" size={15} color={c.ink}>{dir < 0 ? '‹' : '›'}</T>
      </View>
    </Pressable>
  ) : null);
  return (
    <View style={[{ position: 'relative', minWidth: 0 }, style]}>
      <ScrollView ref={ref} horizontal showsHorizontalScrollIndicator={false} scrollEventThrottle={32}
        onScroll={(e) => measure({ x: e.nativeEvent.contentOffset.x })}
        onLayout={(e) => measure({ w: e.nativeEvent.layout.width })}
        onContentSizeChange={(cw) => measure({ cw })}
        contentContainerStyle={{ gap, alignItems: 'center', paddingHorizontal: 2 }}>
        {children}
      </ScrollView>
      {arrow(-1, edge.left)}{arrow(1, edge.right)}
    </View>
  );
}

export const Seg = ({ options, value, onChange, color = c.violet }) => (
  <HScroll>
    {options.map((o) => <Chip key={String(optValue(o))} label={o.label ?? o} emoji={o.emoji} active={optValue(o) === value} onPress={() => onChange(optValue(o))} color={o.color ?? color} />)}
  </HScroll>
);

// A page that hosts another screen (the Work tab hosts the active role's workspace) hands that screen a header: the Screen it renders puts it on top.
const HeaderCtx = React.createContext(null);
export const ScreenHeaderProvider = HeaderCtx.Provider;

/** What every scrolling screen shares: the gutter and max width, the keyboard behaviour, the pull-to-refresh control and the header a host screen hands down. */
function useScreenFrame({ onRefresh, refreshing, padBottom, wide, scroll = true }) {
  const L = useLayout();
  const header = React.useContext(HeaderCtx);
  const bottom = padBottom ?? L.bottomPad;
  // Pull down to reload. The spinner stays up while the screen's own reload runs (at least a moment, so a quick reload is still seen).
  const [pulling, setPulling] = useState(false);
  const pull = async () => {
    setPulling(true);
    try { await Promise.all([Promise.resolve(onRefresh()), new Promise((done) => setTimeout(done, 600))]); } catch { /* the screen shows its own error */ } finally { setPulling(false); }
  };
  const refreshControl = scroll && onRefresh ? <RefreshControl refreshing={pulling || !!refreshing} onRefresh={pull} tintColor={c.mute} colors={[c.pink]} progressBackgroundColor={c.paper} /> : undefined;
  const content = { paddingHorizontal: L.gutter, paddingTop: 8, paddingBottom: bottom, maxWidth: wide ? L.contentMax : Math.min(L.contentMax, L.tablet ? 860 : 760), width: '100%', alignSelf: 'center' };
  const scroller = { style: { flex: 1 }, showsVerticalScrollIndicator: false, keyboardShouldPersistTaps: 'handled', automaticallyAdjustKeyboardInsets: true, refreshControl };
  return { L, header, content, scroller };
}

export function Screen({ children, scroll = true, refreshing, onRefresh, padBottom, style, wide }) {
  const { L, header, content, scroller } = useScreenFrame({ onRefresh, refreshing, padBottom, wide, scroll });
  const Inner = scroll ? ScrollView : View;
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Inner {...(scroll ? scroller : { style: { flex: 1 } })} contentContainerStyle={scroll ? content : undefined}>
        {scroll ? <>{header}{children}</> : <View style={[{ flex: 1, padding: L.gutter }, style]}>{children}</View>}
      </Inner>
    </View>
  );
}

/** A screen whose main content is a long list: the same frame as Screen, but the list is the scroller, so only the rows on screen are built.
 *  Put everything above the rows in `header` and anything below them in `footer` (pass elements, not components, so a search box keeps focus).
 *  `onEndReached` loads the next page; keep a visible "Show more" in `footer` as well, because a short list may never reach the end. */
export function ListScreen({ data, renderItem, keyExtractor, header, footer, empty, onEndReached, gap = 8, numColumns = 1, refreshing, onRefresh, padBottom, wide, extraData }) {
  const { header: host, content, scroller } = useScreenFrame({ onRefresh, refreshing, padBottom, wide });
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <FlatList key={numColumns} data={data} renderItem={renderItem} keyExtractor={keyExtractor} extraData={extraData} numColumns={numColumns}
        {...scroller} contentContainerStyle={content} columnWrapperStyle={numColumns > 1 ? { gap } : undefined}
        ListHeaderComponent={<>{host}{header}</>} ListFooterComponent={footer} ListEmptyComponent={empty}
        ItemSeparatorComponent={() => <View style={{ height: gap }} />} onEndReached={onEndReached} onEndReachedThreshold={0.6}
        initialNumToRender={10} windowSize={7} removeClippedSubviews={Platform.OS === 'android'} />
    </View>
  );
}

export function Loading() {
  const o = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.sequence([
      Animated.timing(o, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE }),
      Animated.timing(o, { toValue: 0.45, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE })]));
    a.start();
    return () => a.stop();
  }, [o]);
  const bar = (w, h = 14) => <View style={{ width: w, height: h, borderRadius: 8, backgroundColor: c.line }} />;
  return (
    <Animated.View style={{ opacity: o, gap: 12, paddingVertical: 8 }}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={[s.card, { backgroundColor: c.paper, padding: 14, flexDirection: 'row', gap: 12, alignItems: 'center' }]}>
          <View style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: c.line }} />
          <View style={{ gap: 8 }}>{bar(170)}{bar(110, 10)}</View>
        </View>
      ))}
    </Animated.View>
  );
}

export const Empty = ({ emoji = '🫥', title, sub }) => (
  <Card color={c.paper} style={{ alignSelf: 'stretch' }}>
    <View style={{ alignItems: 'center', gap: 4, paddingVertical: 8 }}>
      <Text style={{ fontSize: 32 }}>{emoji}</Text><T weight="700" size={15}>{title}</T>{sub ? <T size={13} color={c.mute} style={{ textAlign: 'center' }}>{sub}</T> : null}
    </View>
  </Card>
);

export const ErrorBox = ({ error, onRetry }) => (
  <Card color={c.orangeSoft}><T weight="700">{error?.message ?? t('error.generic')}</T>{onRetry ? <Btn small title={t('common.retry')} onPress={onRetry} style={{ marginTop: 10, alignSelf: 'flex-start' }} color={c.violet} /> : null}</Card>
);

/** Android only: how tall the keyboard is. A sheet lives in its own window, which Android does not shrink for the keyboard, so the sheet is lifted by this much.
 *  iOS lifts scrolling content itself (automaticallyAdjustKeyboardInsets) and the web resizes the page, so both report 0. */
function useKeyboardHeight() {
  const [h, setH] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const a = Keyboard.addListener('keyboardDidShow', (e) => setH(e.endCoordinates?.height ?? 0));
    const b = Keyboard.addListener('keyboardDidHide', () => setH(0));
    return () => { a.remove(); b.remove(); };
  }, []);
  return h;
}

/** Phone: bottom sheet that rises from the edge. Tablet: centred form sheet, like an iPad modal. */
export function Sheet({ visible, onClose, title, children, footer }) {
  const L = useLayout();
  const ins = useSafeAreaInsets();
  const kb = useKeyboardHeight();
  const sheet = L.tablet
    ? { alignSelf: 'center', width: 580, maxWidth: '92%', maxHeight: '86%', borderRadius: 28, marginBottom: 'auto', marginTop: 'auto' }
    : { width: '100%', maxHeight: '92%', borderTopLeftRadius: 28, borderTopRightRadius: 28 };
  return (
    <Modal visible={visible} transparent animationType={L.tablet ? 'fade' : 'slide'} onRequestClose={onClose} statusBarTranslucent>
      <View style={[s.scrim, L.tablet && { justifyContent: 'center' }]}>
        <Pressable style={L.tablet ? StyleSheet.absoluteFill : { flex: 1 }} onPress={onClose} />
        <View style={[s.sheet, sheet, kb && L.phone ? { marginBottom: kb, maxHeight: '80%' } : null]}>
          {L.phone ? <View style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: c.line, marginTop: 8 }} /> : null}
          <ScrollView style={footer ? { flexShrink: 1 } : undefined} contentContainerStyle={{ padding: 20, paddingBottom: 20 + (L.phone && !footer ? ins.bottom : 0), gap: 14 }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <H2>{title}</H2>
              <Pressable onPress={onClose} hitSlop={14} style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}><T size={15} color={c.mute} weight="700">✕</T></Pressable>
            </View>
            {children}
          </ScrollView>
          {footer ? <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14 + (L.phone ? ins.bottom : 0), borderTopWidth: 1, borderColor: c.line }}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

export function StatPill({ value, label, color = c.paper }) {
  const hot = color === c.lime;
  return (
    <View style={[s.stat, hot ? { backgroundColor: c.pink, borderColor: c.pink } : null]}>
      <T weight="800" size={26} color={hot ? c.onAccent : c.ink} style={{ letterSpacing: -0.8, fontVariant: ['tabular-nums'] }}>{value}</T>
      <T weight="700" size={10} color={hot ? c.onAccent : c.mute} style={{ letterSpacing: 1.2, opacity: hot ? 0.85 : 1 }}>{label}</T>
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderWidth: 1, borderColor: c.line, borderRadius: r.card, ...lift },
  gradWrap: { borderRadius: r.card + 4, overflow: 'hidden' },
  btn: { borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  chip: { borderWidth: 1, borderColor: c.line, backgroundColor: c.paper, borderRadius: r.pill, paddingVertical: 10, paddingHorizontal: 16, minHeight: 44, justifyContent: 'center' },
  tag: { borderRadius: 5, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  input: { borderWidth: 1.5, borderColor: c.line, borderRadius: r.input, backgroundColor: c.paper, paddingHorizontal: 16, paddingVertical: 13, minHeight: 50, fontSize: 16, fontWeight: '500', color: c.ink },
  secRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  scrim: { flex: 1, backgroundColor: 'rgba(5,8,18,0.55)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: c.bg, overflow: 'hidden' },
  stat: { borderRadius: 16, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', minWidth: 82 },
});
