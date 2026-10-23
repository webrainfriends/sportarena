import React from 'react';
import { Image, Pressable, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Icon } from '../icons';
import { mediaUrl } from '../api';
import { T } from '../ui';
import { useLayout } from '../layout';
import { Glass } from '../glass';
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
            <Glass key={s.label} accessible accessibilityLabel={`${s.value} ${s.label}`} radius={22} blur={10} tint="rgba(255,255,255,0.2)" gloss iris style={{ flex: 1, paddingVertical: 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {s.icon ? <Icon name={s.icon} color="#fff" size={20} on /> : null}
              <View style={{ flexShrink: 1 }}>
                <T weight="800" size={20} color="#fff" numberOfLines={1} style={{ fontVariant: ['tabular-nums'] }}>{s.value}</T>
                <T weight="700" size={9.5} color="rgba(255,255,255,0.85)" style={{ letterSpacing: 1 }}>{String(s.label).toUpperCase()}</T>
              </View>
            </Glass>
          ))}
        </View>
      ) : null}
      {tabs ? (
        <Glass accessibilityRole="tablist" radius={999} blur={10} tint="rgba(11,27,50,0.28)" gloss style={{ flexDirection: 'row', marginTop: 18, padding: 4 }}>
          {tabs.items.map(([k, label]) => {
            const on = k === tabs.value;
            return (
              <Pressable key={k} onPress={() => tabs.onChange(k)} accessibilityRole="tab" accessibilityState={{ selected: on }} style={{ flex: 1 }}>
                <Glass radius={999} blur={8} tint={on ? 'rgba(255,255,255,0.82)' : 'rgba(255,255,255,0)'} gloss={on} style={{ alignItems: 'center', paddingVertical: 8, ...(on ? null : { borderWidth: 0, boxShadow: 'none', backdropFilter: 'none', WebkitBackdropFilter: 'none' }) }}>
                  <T weight="700" size={13} color={on ? '#0D1E4C' : '#fff'} numberOfLines={1}>{label}</T>
                </Glass>
              </Pressable>
            );
          })}
        </Glass>
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
