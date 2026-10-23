import React from 'react';
import { Platform, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { dark } from './theme';

// Native blur comes from expo-blur; where it is unavailable the surface falls back to a flat translucent fill.
let BlurView = null;
if (Platform.OS !== 'web') { try { BlurView = require('expo-blur').BlurView; } catch { BlurView = null; } }

export const glassTint = dark ? 'rgba(13,30,76,0.42)' : 'rgba(255,255,255,0.45)';
export const glassRim = 'rgba(255,255,255,0.3)';
// Light presets keep whatever is behind clearly recognisable: `clear` for discs, `soft` for text-bearing pills and circles.
export const GLASS = {
  clear: { blur: 6, tint: dark ? 'rgba(13,30,76,0.12)' : 'rgba(255,255,255,0.14)' },
  soft: { blur: 12, tint: dark ? 'rgba(11,27,50,0.42)' : 'rgba(255,255,255,0.5)' },
};

// Iridescent edge, kept inside the palette: mint, teal, sage and a pale aqua.
const IRIS = dark
  ? ['rgba(229,201,215,0.30)', 'rgba(131,166,206,0.30)', 'rgba(196,140,179,0.34)', 'rgba(159,227,232,0.22)']
  : ['rgba(229,201,215,0.55)', 'rgba(131,166,206,0.22)', 'rgba(196,140,179,0.28)', 'rgba(159,227,232,0.30)'];

/**
 * Liquid-glass surface: the content behind it shows through, blurred and lightly tinted. Web uses CSS backdrop-filter;
 * native uses expo-blur; otherwise a translucent fill. `gloss` adds the glossy look (specular rim, top highlight, soft
 * caustic) and `iris` a faint palette-green iridescent shimmer, both drawn as plain Views so they work without blur.
 */
export function Glass({ radius = 24, preset, blur: b, tint: t, gloss = false, iris = false, style, children, ...rest }) {
  const blur = b ?? (preset ? GLASS[preset].blur : 24);
  const tint = t ?? (preset ? GLASS[preset].tint : glassTint);
  const web = Platform.OS === 'web';
  const rim = gloss
    ? 'inset 1.5px 1.5px 0 rgba(255,255,255,0.75), inset -1px -1px 0 rgba(255,255,255,0.28), inset 0 0 22px rgba(255,255,255,0.14), 0 8px 24px rgba(0,0,0,0.14)'
    : 'inset 0 1px 0 rgba(255,255,255,0.4), 0 8px 24px rgba(0,0,0,0.12)';
  const base = { borderRadius: radius, overflow: 'hidden', ...(web && gloss ? { borderWidth: 0 } : { borderWidth: 1, borderColor: gloss ? 'rgba(255,255,255,0.55)' : glassRim }) };
  const fill = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 };
  const layers = (
    <>
      {iris ? <LinearGradient pointerEvents="none" colors={IRIS} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={fill} /> : null}
      {gloss ? (
        <>
          <LinearGradient pointerEvents="none" colors={['rgba(255,255,255,0.55)', 'rgba(255,255,255,0.08)', 'rgba(255,255,255,0)']} start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '50%' }} />
          <View pointerEvents="none" style={{ position: 'absolute', right: '-12%', bottom: '-30%', width: '70%', height: '70%', borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.16)' }} />
        </>
      ) : null}
    </>
  );
  if (web) {
    const f = `blur(${blur}px) saturate(1.6) brightness(1.05)`;
    return (
      <View {...rest} style={[base, { backgroundColor: tint, backdropFilter: f, WebkitBackdropFilter: f, boxShadow: rim }, style]}>
        {layers}
        {children}
      </View>
    );
  }
  return (
    <View {...rest} style={[base, { backgroundColor: BlurView ? 'transparent' : tint }, style]}>
      {BlurView ? <BlurView intensity={Math.min(100, blur * 2.5)} tint={dark ? 'dark' : 'light'} style={{ ...fill, backgroundColor: tint }} /> : null}
      {layers}
      {children}
    </View>
  );
}
