import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

// Native: Keychain / Keystore via SecureStore. Web: localStorage (use HTTPS + a strict CSP in production).
export const storage = {
  async get(k) { try { return Platform.OS === 'web' ? localStorage.getItem(k) : await SecureStore.getItemAsync(k); } catch { return null; } },
  async set(k, v) { try { Platform.OS === 'web' ? localStorage.setItem(k, v) : await SecureStore.setItemAsync(k, v); } catch {} },
  async del(k) { try { Platform.OS === 'web' ? localStorage.removeItem(k) : await SecureStore.deleteItemAsync(k); } catch {} },
};
