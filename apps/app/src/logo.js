import React from 'react';
import { Image } from 'react-native';

/** The Gotmygame logo (assets/logo.png). Square; pass the edge length. */
export function Logo({ size = 40, style }) {
  return <Image source={require('../assets/logo.png')} accessibilityLabel="Gotmygame" style={[{ width: size, height: size, borderRadius: size * 0.22 }, style]} resizeMode="contain" />;
}

/** The full Gotmygame lockup with its wordmark (assets/logo-full.png), 3:2. Pass the width; for hero and splash-like places on a dark surface. */
export function LogoFull({ width = 240, style }) {
  return <Image source={require('../assets/logo-full.png')} accessibilityLabel="Gotmygame, the sportsverse" style={[{ width, height: width * (2 / 3), borderRadius: width * 0.04 }, style]} resizeMode="contain" />;
}
