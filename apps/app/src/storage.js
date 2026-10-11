import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

// Native: Keychain / Keystore via SecureStore. Web: localStorage for harmless preferences only (e.g. the active role).
// Credentials never touch web storage: the web session is an HttpOnly cookie managed by the server, and the guard below
// makes it impossible to write one there by mistake.
const SECRET_KEYS = new Set(['token', 'refresh']);
const webOk = (k) => Platform.OS !== 'web' || !SECRET_KEYS.has(k);
export const storage = {
  async get(k) { try { return Platform.OS === 'web' ? (webOk(k) ? localStorage.getItem(k) : null) : await SecureStore.getItemAsync(k); } catch { return null; } },
  async set(k, v) { try { if (Platform.OS === 'web') { if (webOk(k)) localStorage.setItem(k, v); } else await SecureStore.setItemAsync(k, v); } catch {} },
  // Removing is always allowed on web: it also clears a bearer token left in localStorage by earlier builds.
  async del(k) { try { Platform.OS === 'web' ? localStorage.removeItem(k) : await SecureStore.deleteItemAsync(k); } catch {} },
};
