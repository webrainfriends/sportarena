import React from 'react';
import { Image } from 'react-native';

/** The Gotmygame logo (assets/logo.png). Square; pass the edge length. */
export function Logo({ size = 40, style }) {
  return <Image source={require('../assets/logo.png')} accessibilityLabel="Gotmygame" style={[{ width: size, height: size, borderRadius: size * 0.22 }, style]} resizeMode="contain" />;
}
