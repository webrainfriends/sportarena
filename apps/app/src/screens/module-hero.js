import React from 'react';
import { Image, Pressable, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Icon } from '../icons';
import { mediaUrl } from '../api';
import { T } from '../ui';
import { useLayout } from '../layout';
import { c, dark } from '../theme';
import { TileArt, tileColors } from './more-art';

/**
 * Top of a module screen: the module's gradient, its illustration bleeding off the corner, an optional real photo
 * behind it, and white stat chips. `name` is the route name (colour + art). Stats with no value are left out, so
 * nothing is invented. The NavBar floats over its top edge on these routes (see HERO_ROUTES in App.js).
 */
export function ModuleHero({ name, title, sub, stats = [], photo, tabs, children }) {
  const L = useLayout();
  const bleed = L.phone;
  const [from, to] = tileColors(name);
  const shown = stats.filter((s) => s && s.value !== undefined && s.value !== null && s.value !== '');
  return (
    <LinearGradient colors={[from, to]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: bleed ? 0 : 28, overflow: 'hidden', paddingHorizontal: 18, paddingTop: 64, paddingBottom: 44, ...(bleed ? { marginHorizontal: -L.gutter, marginTop: -8 } : null) }}>
      {photo ? <Image source={{ uri: mediaUrl(photo) }} resizeMode="cover" accessibilityIgnoresInvertColors style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, opacity: 0.4 }} /> : null}
      <View pointerEvents="none" style={{ position: 'absolute', right: -50, top: -40, width: 230, height: 230, borderRadius: 115, backgroundColor: '#fff', opacity: 0.13 }} />
      <TileArt name={name} size={150} style={{ position: 'absolute', right: -14, top: 34, transform: [{ rotate: '-8deg' }], opacity: dark ? 0.9 : 1 }} />
      <View style={{ maxWidth: '62%' }}>
        <T weight="800" size={28} color="#fff" style={{ letterSpacing: -0.8 }}>{title}</T>
        {sub ? <T size={14} color="rgba(255,255,255,0.88)" style={{ marginTop: 4 }}>{sub}</T> : null}
      </View>
      {children}
      {shown.length ? (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 18 }}>
          {shown.map((s) => (
            <View key={s.label} accessible accessibilityLabel={`${s.value} ${s.label}`} style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.96)', borderRadius: 18, paddingVertical: 10, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {s.icon ? <Icon name={s.icon} color={to} size={20} on /> : null}
              <View style={{ flexShrink: 1 }}>
                <T weight="800" size={20} color="#0F172A" numberOfLines={1} style={{ fontVariant: ['tabular-nums'] }}>{s.value}</T>
                <T weight="700" size={9.5} color="#64748B" style={{ letterSpacing: 1 }}>{String(s.label).toUpperCase()}</T>
              </View>
            </View>
          ))}
        </View>
      ) : null}
      {tabs ? (
        <View accessibilityRole="tablist" style={{ flexDirection: 'row', marginTop: 18, padding: 4, borderRadius: 999, backgroundColor: 'rgba(15,23,42,0.28)' }}>
          {tabs.items.map(([k, label]) => {
            const on = k === tabs.value;
            return (
              <Pressable key={k} onPress={() => tabs.onChange(k)} accessibilityRole="tab" accessibilityState={{ selected: on }} style={{ flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 999, backgroundColor: on ? '#fff' : 'transparent' }}>
                <T weight="700" size={13} color={on ? to : '#fff'} numberOfLines={1}>{label}</T>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </LinearGradient>
  );
}

/** The content that follows a ModuleHero: a rounded sheet that slides up over the hero's bottom edge. */
export function ModuleSheet({ children }) {
  const L = useLayout();
  return (
    <View style={{ marginTop: -28, backgroundColor: c.bg, borderTopLeftRadius: 32, borderTopRightRadius: 32, paddingTop: 22, ...(L.phone ? { marginHorizontal: -L.gutter, paddingHorizontal: L.gutter } : null) }}>
      {children}
    </View>
  );
}
