import React from 'react';
import { Platform, View } from 'react-native';
import { dark } from './theme';

// Native blur comes from expo-blur; where it is unavailable the surface falls back to a flat translucent fill.
let BlurView = null;
if (Platform.OS !== 'web') { try { BlurView = require('expo-blur').BlurView; } catch { BlurView = null; } }

export const glassTint = dark ? 'rgba(11,43,38,0.42)' : 'rgba(255,255,255,0.45)';
export const glassRim = 'rgba(255,255,255,0.3)';
// Light presets keep whatever is behind clearly recognisable: `clear` for discs, `soft` for text-bearing pills and circles.
export const GLASS = {
  clear: { blur: 6, tint: dark ? 'rgba(11,43,38,0.12)' : 'rgba(255,255,255,0.14)' },
  soft: { blur: 12, tint: dark ? 'rgba(5,31,32,0.42)' : 'rgba(255,255,255,0.5)' },
};

/**
 * Liquid-glass surface: the content behind it shows through, blurred and lightly tinted, with a thin light rim and a top
 * highlight. Web uses CSS backdrop-filter; native uses expo-blur; otherwise a translucent fill.
 */
export function Glass({ radius = 24, preset, blur: b, tint: t, style, children, ...rest }) {
  const blur = b ?? (preset ? GLASS[preset].blur : 24);
  const tint = t ?? (preset ? GLASS[preset].tint : glassTint);
  const base = { borderRadius: radius, overflow: 'hidden', borderWidth: 1, borderColor: glassRim };
  if (Platform.OS === 'web') {
    const f = `blur(${blur}px) saturate(1.6) brightness(1.05)`;
    return (
      <View {...rest} style={[base, { backgroundColor: tint, backdropFilter: f, WebkitBackdropFilter: f, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.4), 0 8px 24px rgba(0,0,0,0.12)' }, style]}>
        {children}
      </View>
    );
  }
  return (
    <View {...rest} style={[base, { backgroundColor: BlurView ? 'transparent' : tint }, style]}>
      {BlurView ? <BlurView intensity={Math.min(100, blur * 2.5)} tint={dark ? 'dark' : 'light'} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: tint }} /> : null}
      {children}
    </View>
  );
}
