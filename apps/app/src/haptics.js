// Light touch feedback on iOS, iPadOS and Android. A no-op on the web, and never throws (some devices have no haptic motor).
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

const ON = Platform.OS !== 'web';

/** A light tap: buttons, chips, cards, tabs. */
export const tick = () => { if (ON) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); };

/** A selection change: switches, steppers, pickers. */
export const select = () => { if (ON) Haptics.selectionAsync().catch(() => {}); };

/** Wrap a press handler so it gives a light tap first. Leaves a missing handler missing, so disabled-looking things stay inert. */
export const tapped = (fn) => (fn ? (...args) => { tick(); return fn(...args); } : fn);
