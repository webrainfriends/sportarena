import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Btn, Chip, Field, Sheet, T } from './ui';
import { c } from './theme';
import { addDays, moneyIn, WEEKDAYS } from './vtime';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
export const monthOf = (date) => date.slice(0, 7);
const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export { todayLocal };

const DOT = { available: c.mint, limited: c.sun, full: c.red, closed: '#94A3B8' };
const NO_PICK = new Set(['past', 'closed', 'full', 'too_far']);

/**
 * Month calendar. Plain mode picks a date; with `days` (from venue_calendar) it shows availability dots and the
 * cheapest price per day and only lets you pick bookable days; with `range` it highlights a from–to span.
 * `month` is 'YYYY-MM' and controlled by the parent so it can fetch that month's availability.
 */
export function Calendar({ month, onMonth, value, onChange, days, minDate, maxDate, range, currency, today = todayLocal() }) {
  const [y, mo] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, mo - 1, 1));
  const lead = first.getUTCDay();
  const count = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const info = useMemo(() => new Map((days ?? []).map((d) => [d.date, d])), [days]);
  const cells = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  while (cells.length % 7) cells.push(null);
  const inRange = (d) => range?.from && range?.to && d >= range.from && d <= range.to;
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <Pressable onPress={() => onMonth(shiftMonth(month, -1))} hitSlop={10} accessibilityLabel="Previous month" style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}><T size={22} weight="700">‹</T></Pressable>
        <T weight="700" size={16}>{MONTHS[mo - 1]} {y}</T>
        <Pressable onPress={() => onMonth(shiftMonth(month, 1))} hitSlop={10} accessibilityLabel="Next month" style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}><T size={22} weight="700">›</T></Pressable>
      </View>
      <View style={{ flexDirection: 'row' }}>{WEEKDAYS.map((w) => <View key={w} style={{ width: `${100 / 7}%`, alignItems: 'center', paddingBottom: 6 }}><T size={11} color={c.mute} weight="700">{w.toUpperCase()}</T></View>)}</View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {cells.map((d, i) => {
          if (!d) return <View key={`b${i}`} style={{ width: `${100 / 7}%`, height: days ? 58 : 46 }} />;
          const meta = info.get(d);
          const blocked = (minDate && d < minDate) || (maxDate && d > maxDate) || (meta && NO_PICK.has(meta.status));
          const on = value === d || range?.from === d || range?.to === d;
          const mid = inRange(d) && !on;
          return (
            <Pressable key={d} disabled={!!blocked} onPress={() => onChange(d)} accessibilityLabel={`${d}${meta ? `, ${meta.status}` : ''}`}
              style={{ width: `${100 / 7}%`, height: days ? 58 : 46, alignItems: 'center', justifyContent: 'center', padding: 2 }}>
              <View style={{ width: '100%', flex: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.pink : mid ? c.pinkSoft : 'transparent', borderWidth: d === today && !on ? 1.5 : 0, borderColor: c.pink, opacity: blocked ? 0.35 : 1 }}>
                <T weight="700" size={15} color={on ? '#fff' : c.ink} style={meta?.status === 'closed' ? { textDecorationLine: 'line-through' } : null}>{Number(d.slice(8))}</T>
                {meta && !NO_PICK.has(meta.status) ? (
                  <>
                    {meta.from_price_cents != null ? <T size={9} color={on ? '#fff' : c.mute} weight="600">{moneyIn(meta.from_price_cents, currency).replace(/\.00$/, '')}</T> : null}
                    <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: on ? '#fff' : DOT[meta.status], marginTop: 1 }} />
                  </>
                ) : meta && meta.status !== 'past' ? <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: DOT[meta.status] ?? c.line, marginTop: 2 }} /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      {days ? (
        <View style={{ flexDirection: 'row', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
          {[['available', 'Available'], ['limited', 'Filling fast'], ['full', 'Full'], ['closed', 'Closed']].map(([k, l]) => <View key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: DOT[k] }} /><T size={11} color={c.mute}>{l}</T></View>)}
        </View>
      ) : null}
    </View>
  );
}

/** A read-only looking field that opens a calendar sheet. value/onChange use 'YYYY-MM-DD'. */
export function DateField({ label, value, onChange, optional, min, max, hint }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState((value ?? todayLocal()).slice(0, 7));
  return (
    <View style={{ gap: 6 }}>
      {label ? <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{(label + (optional ? ' (optional)' : '')).toUpperCase()}</T> : null}
      <Pressable onPress={() => { setMonth((value ?? todayLocal()).slice(0, 7)); setOpen(true); }} style={{ borderWidth: 1.5, borderColor: c.line, borderRadius: 12, backgroundColor: c.paper, paddingHorizontal: 16, minHeight: 50, justifyContent: 'center', flexDirection: 'row', alignItems: 'center' }}>
        <T style={{ flex: 1 }} color={value ? c.ink : '#94A3B8'} weight="600">{value ? new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'Pick a date'}</T>
        <T size={18}>📅</T>
      </Pressable>
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
      <Sheet visible={open} onClose={() => setOpen(false)} title={label ?? 'Pick a date'}>
        <Calendar month={month} onMonth={setMonth} value={value} minDate={min} maxDate={max} onChange={(d) => { onChange(d); setOpen(false); }} />
        {optional && value ? <Btn small title="Clear" color={c.paper} onPress={() => { onChange(undefined); setOpen(false); }} /> : null}
      </Sheet>
    </View>
  );
}

const PARTS = [['Morning', 0, 12], ['Afternoon', 12, 17], ['Evening', 17, 21], ['Night', 21, 24]];
/** Group items by the part of the local day they start in (BookMyShow-style Morning / Afternoon / Evening / Night). */
export function byPartOfDay(items, hourOf) {
  return PARTS.map(([label, a, b]) => ({ label, items: items.filter((x) => { const h = hourOf(x); return h >= a && h < b; }) })).filter((g) => g.items.length);
}

/** A time field: chips every `step` minutes, grouped by part of day. value/onChange use 'HH:MM'. */
export function TimeField({ label, value, onChange, optional, step = 30, hint }) {
  const [open, setOpen] = useState(false);
  const times = Array.from({ length: (24 * 60) / step + 1 }, (_, i) => i * step).filter((m) => m <= 1440).map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  const fmt = (t) => { if (t === '24:00') return 'End of day'; const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 || h === 24 ? 'AM' : 'PM'}`; };
  return (
    <View style={{ gap: 6 }}>
      {label ? <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{(label + (optional ? ' (optional)' : '')).toUpperCase()}</T> : null}
      <Pressable onPress={() => setOpen(true)} style={{ borderWidth: 1.5, borderColor: c.line, borderRadius: 12, backgroundColor: c.paper, paddingHorizontal: 16, minHeight: 50, justifyContent: 'center', flexDirection: 'row', alignItems: 'center' }}>
        <T style={{ flex: 1 }} color={value ? c.ink : '#94A3B8'} weight="600">{value ? fmt(value) : 'Pick a time'}</T><T size={18}>🕒</T>
      </Pressable>
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
      <Sheet visible={open} onClose={() => setOpen(false)} title={label ?? 'Pick a time'}>
        {byPartOfDay(times, (t) => Number(t.slice(0, 2))).map((g) => (
          <View key={g.label} style={{ gap: 8 }}>
            <T weight="700" size={13} color={c.mute}>{g.label}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{g.items.map((t) => <Chip key={t} label={fmt(t)} active={value === t} onPress={() => { onChange(t); setOpen(false); }} />)}</View>
          </View>
        ))}
        {optional && value ? <Btn small title="Clear" color={c.paper} onPress={() => { onChange(undefined); setOpen(false); }} /> : null}
      </Sheet>
    </View>
  );
}

/** − 2 + control for quantities (units, players, hours). */
export function Counter({ value, onChange, min = 1, max = 99, label, suffix, step = 1 }) {
  const btn = (txt, d, off) => (
    <Pressable disabled={off} onPress={() => onChange(Math.min(max, Math.max(min, Math.round((value + d * step) * 100) / 100)))} accessibilityLabel={d > 0 ? 'More' : 'Fewer'} style={{ width: 40, height: 40, borderRadius: 20, borderWidth: 1.5, borderColor: off ? c.line : c.pink, alignItems: 'center', justifyContent: 'center', opacity: off ? 0.4 : 1 }}>
      <T size={20} weight="700" color={c.pink}>{txt}</T>
    </Pressable>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      {label ? <T weight="600" style={{ flex: 1 }}>{label}</T> : null}
      {btn('−', -1, value <= min)}<T weight="700" size={17} style={{ minWidth: 34, textAlign: 'center' }}>{value}{suffix ?? ''}</T>{btn('+', 1, value >= max)}
    </View>
  );
}

/** Numbered progress steps for the booking wizard. */
export function Stepper({ steps, current, onJump }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10 }}>
      {steps.map((label, i) => {
        const done = i < current, on = i === current;
        return (
          <React.Fragment key={label}>
            <Pressable disabled={!done} onPress={() => onJump?.(i)} style={{ alignItems: 'center', minWidth: 54 }}>
              <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: done ? c.mint : on ? c.pink : c.violetSoft, alignItems: 'center', justifyContent: 'center' }}>
                <T size={13} weight="700" color={done || on ? '#fff' : c.mute}>{done ? '✓' : i + 1}</T>
              </View>
              <T size={10.5} weight={on ? '700' : '500'} color={on ? c.ink : c.mute} style={{ marginTop: 3 }}>{label}</T>
            </Pressable>
            {i < steps.length - 1 ? <View style={{ flex: 1, height: 2, backgroundColor: i < current ? c.mint : c.line, marginBottom: 14 }} /> : null}
          </React.Fragment>
        );
      })}
    </View>
  );
}

/** Pinned summary + call to action above the tab bar. */
export function StickyBar({ title, sub, action, onAction, disabled, loading, bottom = 0 }) {
  return (
    <View style={{ backgroundColor: c.paper, borderTopWidth: 1, borderColor: c.line, paddingHorizontal: 16, paddingVertical: 10, marginBottom: bottom, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ flex: 1 }}><T weight="700" size={16}>{title}</T>{sub ? <T size={12} color={c.mute}>{sub}</T> : null}</View>
      <Btn title={action} onPress={onAction} disabled={disabled} loading={loading} />
    </View>
  );
}

export { addDays, Field };
