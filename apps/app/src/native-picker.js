// The phone's own date and time pickers (iOS wheel / inline calendar, Android dialog). The web build uses native-picker.web.js, which turns this off,
// so the in-app calendar and time chips stay there. Values are the same strings the rest of the app uses: 'YYYY-MM-DD' and 'HH:MM'. They are built
// from the device's local parts (never UTC), so a picked day never shifts across midnight.
import React from 'react';
import { Platform } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { c, dark } from './theme';

export const NATIVE_PICKER = true;
const pad = (n) => String(n).padStart(2, '0');

export const parseDay = (s) => (s ? new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))) : undefined);
export const fmtDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseClock = (s) => { const d = new Date(); const [h, m] = (s ?? '09:00').split(':').map(Number); d.setHours(h, m, 0, 0); return d; };
export const fmtClock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// iOS only accepts these minute intervals
const INTERVALS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const interval = (step) => (INTERVALS.includes(step) ? step : 1);

/** iOS: the picker itself, drawn inside the app's own sheet. mode 'date' is an inline calendar, 'time' a wheel. */
export function NativeWheel({ mode, value, min, max, step, onChange }) {
  return (
    <DateTimePicker mode={mode} display={mode === 'date' ? 'inline' : 'spinner'} value={value} minimumDate={min} maximumDate={max} minuteInterval={mode === 'time' ? interval(step) : undefined}
      accentColor={c.pink} themeVariant={dark ? 'dark' : 'light'} onChange={(e, d) => { if (d && e.type !== 'dismissed') onChange(d); }} />
  );
}

/** Android: the system dialog. Calls onPick only when the person confirms. */
export function openDialog({ mode, value, min, max, onPick }) {
  if (Platform.OS !== 'android') return;
  DateTimePickerAndroid.open({ mode, value, minimumDate: min, maximumDate: max, is24Hour: false, onChange: (e, d) => { if (e.type === 'set' && d) onPick(d); } });
}
