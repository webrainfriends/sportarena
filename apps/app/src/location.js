import { Platform } from 'react-native';

/**
 * The device's position for one search ("games near me"). Rounded to about 100 m, sent as query parameters only, never stored by the server
 * and never shown to anyone else. Resolves null when the person declines or the device has no location service.
 */
export async function currentPosition() {
  const round = (n) => Math.round(n * 1000) / 1000;
  try {
    if (Platform.OS === 'web') {
      if (typeof navigator === 'undefined' || !navigator.geolocation) return null;
      return await new Promise((resolve) => navigator.geolocation.getCurrentPosition((p) => resolve({ lat: round(p.coords.latitude), lng: round(p.coords.longitude) }), () => resolve(null), { timeout: 10000, maximumAge: 300000 }));
    }
    const Location = require('expo-location');
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== 'granted') return null;
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { lat: round(p.coords.latitude), lng: round(p.coords.longitude) };
  } catch { return null; }
}
