import React, { useMemo, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Btn, Chip, Field, HScroll, Sheet, T } from './ui';
export { HScroll };
import { c } from './theme';
import { addDays, moneyIn, WEEKDAYS } from './vtime';
import { locale } from './locale';
import { NATIVE_PICKER, NativeWheel, openDialog, parseDay, fmtDay, parseClock, fmtClock } from './native-picker';
import { select, tapped } from './haptics';
import { t } from './i18n';

export const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
export const monthOf = (date) => date.slice(0, 7);
const pad2 = (n) => String(n).padStart(2, '0');
export const monthStart = (m) => `${m}-01`;
export const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return `${m}-${pad2(new Date(Date.UTC(y, mo, 0)).getUTCDate())}`; };
/** Month name in the person's own language and script ('long' or 'short'). */
const monthName = (m, month = 'long') => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(locale, { month, timeZone: 'UTC' });
const todayLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export { todayLocal };

const DOT = { available: c.mint, limited: c.sun, full: c.red, closed: c.mute };
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
  const [jump, setJump] = useState(false);
  const arrow = { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' };
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <Pressable onPress={() => onMonth(shiftMonth(month, -1))} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('cal.prev_month')} style={arrow}><T size={22} weight="700">‹</T></Pressable>
        <Pressable onPress={() => setJump((x) => !x)} accessibilityRole="button" accessibilityLabel={t('cal.jump')} accessibilityState={{ expanded: jump }} style={{ minHeight: 44, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <T weight="700" size={16}>{monthName(month)} {y}</T><T size={12} color={c.mute}>{jump ? '▴' : '▾'}</T>
        </Pressable>
        <Pressable onPress={() => onMonth(shiftMonth(month, 1))} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('cal.next_month')} style={arrow}><T size={22} weight="700">›</T></Pressable>
      </View>
      {jump ? <MonthGrid year={y} picked={month} minDate={minDate} maxDate={maxDate} onPick={(m) => { onMonth(m); setJump(false); }} /> : <>
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
                <T weight="700" size={15} color={on ? c.onAccent : c.ink} style={meta?.status === 'closed' ? { textDecorationLine: 'line-through' } : null}>{Number(d.slice(8))}</T>
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
      </>}
    </View>
  );
}

/** Twelve months of one year with a year stepper: jump straight to a month instead of tapping ‹ › again and again. */
export function MonthGrid({ year, picked, from, to, minDate, maxDate, onPick }) {
  const [y, setY] = useState(year);
  const arrow = { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' };
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <Pressable onPress={() => setY(y - 1)} accessibilityRole="button" accessibilityLabel={t('cal.prev_year')} style={arrow}><T size={22} weight="700">‹</T></Pressable>
        <T weight="700" size={18} accessibilityLabel={`${t('cal.year')} ${y}`} style={{ minWidth: 64, textAlign: 'center' }}>{y}</T>
        <Pressable onPress={() => setY(y + 1)} accessibilityRole="button" accessibilityLabel={t('cal.next_year')} style={arrow}><T size={22} weight="700">›</T></Pressable>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {Array.from({ length: 12 }, (_, i) => `${y}-${pad2(i + 1)}`).map((m) => {
          const off = (minDate && monthEnd(m) < minDate) || (maxDate && monthStart(m) > maxDate);
          const on = m === picked || m === from || m === to;
          const mid = from && to && m > from && m < to;
          return (
            <Pressable key={m} disabled={!!off} onPress={() => { select(); onPick(m); }} accessibilityRole="button" accessibilityLabel={`${monthName(m)} ${y}`} accessibilityState={{ selected: !!on, disabled: !!off }}
              style={{ width: '33.333%', height: 54, padding: 3 }}>
              <View style={{ flex: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.pink : mid ? c.pinkSoft : 'transparent', borderWidth: m === todayLocal().slice(0, 7) && !on ? 1.5 : 0, borderColor: c.pink, opacity: off ? 0.35 : 1 }}>
                <T weight="700" size={15} color={on ? c.onAccent : c.ink}>{monthName(m, 'short')}</T>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Twelve years at a time, paged: pick a year (or a first and last year) without stepping one year at a time. */
export function YearGrid({ base, from, to, minYear, onPick }) {
  const [start, setStart] = useState(Math.floor(base / 12) * 12);
  const arrow = { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' };
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <Pressable onPress={() => setStart(start - 12)} accessibilityRole="button" accessibilityLabel={t('cal.earlier_years')} style={arrow}><T size={22} weight="700">‹</T></Pressable>
        <T weight="700" size={16} style={{ minWidth: 110, textAlign: 'center' }}>{start} – {start + 11}</T>
        <Pressable onPress={() => setStart(start + 12)} accessibilityRole="button" accessibilityLabel={t('cal.later_years')} style={arrow}><T size={22} weight="700">›</T></Pressable>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {Array.from({ length: 12 }, (_, i) => start + i).map((yr) => {
          const off = minYear != null && yr < minYear;
          const on = yr === from || yr === to;
          const mid = from && to && yr > from && yr < to;
          return (
            <Pressable key={yr} disabled={off} onPress={() => { select(); onPick(yr); }} accessibilityRole="button" accessibilityLabel={`${t('cal.year')} ${yr}`} accessibilityState={{ selected: on, disabled: off }}
              style={{ width: '33.333%', height: 54, padding: 3 }}>
              <View style={{ flex: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.pink : mid ? c.pinkSoft : 'transparent', borderWidth: yr === new Date().getFullYear() && !on ? 1.5 : 0, borderColor: c.pink, opacity: off ? 0.35 : 1 }}>
                <T weight="700" size={15} color={on ? c.onAccent : c.ink}>{yr}</T>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** A read-only looking field that opens a calendar sheet. value/onChange use 'YYYY-MM-DD'. */
export function DateField({ label, value, onChange, optional, min, max, hint }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState((value ?? todayLocal()).slice(0, 7));
  const android = NATIVE_PICKER && Platform.OS === 'android';
  const start = () => {
    if (android) return openDialog({ mode: 'date', value: parseDay(value) ?? new Date(), min: parseDay(min), max: parseDay(max), onPick: (d) => onChange(fmtDay(d)) });
    setMonth((value ?? todayLocal()).slice(0, 7)); setOpen(true);
  };
  return (
    <View style={{ gap: 6 }}>
      {label ? <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{(label + (optional ? ' (optional)' : '')).toUpperCase()}</T> : null}
      <Pressable onPress={start} style={{ borderWidth: 1.5, borderColor: c.line, borderRadius: 12, backgroundColor: c.paper, paddingHorizontal: 16, minHeight: 50, justifyContent: 'center', flexDirection: 'row', alignItems: 'center' }}>
        <T style={{ flex: 1 }} color={value ? c.ink : c.mute} weight="600">{value ? new Date(`${value}T00:00:00Z`).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'Pick a date'}</T>
        <T size={18}>📅</T>
      </Pressable>
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
      {android && optional && value ? <Btn small title="Clear" color={c.paper} ink={c.ink} onPress={() => onChange(undefined)} style={{ alignSelf: 'flex-start' }} /> : null}
      <Sheet visible={open} onClose={() => setOpen(false)} title={label ?? 'Pick a date'}>
        {NATIVE_PICKER
          ? <NativeWheel mode="date" value={parseDay(value) ?? new Date()} min={parseDay(min)} max={parseDay(max)} onChange={(d) => { select(); onChange(fmtDay(d)); setOpen(false); }} />
          : <Calendar month={month} onMonth={setMonth} value={value} minDate={min} maxDate={max} onChange={(d) => { onChange(d); setOpen(false); }} />}
        {optional && value ? <Btn small title="Clear" color={c.paper} onPress={() => { onChange(undefined); setOpen(false); }} /> : null}
      </Sheet>
    </View>
  );
}

/**
 * Pick a from–to range: tap days on the calendar, or switch to whole months or whole years, or take a quick range
 * (this month, next 3 / 6 / 12 months, rest of the year). value/onChange use 'YYYY-MM-DD'.
 */
export function DateRangeField({ label, from, to, onChange, optional, min, hint }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('days');
  const [draft, setDraft] = useState({ from, to });
  const [month, setMonth] = useState((from ?? todayLocal()).slice(0, 7));
  const today = todayLocal();
  const days = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 : 0;
  const fmt = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const fmtM = (m) => `${monthName(m, 'short')} ${m.slice(0, 4)}`;
  const floor = min && min > today ? min : today;
  const done = (f, e) => { onChange({ from: f < floor && e >= floor ? floor : f, to: e }); setOpen(false); };
  const cur = today.slice(0, 7);
  const PRESETS = [
    ['cal.preset.this_month', () => done(today, monthEnd(cur))],
    ['cal.preset.next_3', () => done(today, monthEnd(shiftMonth(cur, 2)))],
    ['cal.preset.next_6', () => done(today, monthEnd(shiftMonth(cur, 5)))],
    ['cal.preset.rest_of_year', () => done(today, `${today.slice(0, 4)}-12-31`)],
    ['cal.preset.next_12', () => done(today, monthEnd(shiftMonth(cur, 11)))],
  ];
  const pick = (d) => {
    if (!draft.from || draft.to) return setDraft({ from: d, to: undefined });          // start a new range
    if (d < draft.from) return setDraft({ from: d, to: undefined });
    onChange({ from: draft.from, to: d }); setOpen(false);
  };
  const pickMonth = (m) => {
    if (!draft.fm || draft.tm || m < draft.fm) return setDraft({ fm: m });
    done(monthStart(draft.fm), monthEnd(m));
  };
  const pickYear = (yr) => {
    if (!draft.fy || draft.ty || yr < draft.fy) return setDraft({ fy: yr });
    done(`${draft.fy}-01-01`, `${yr}-12-31`);
  };
  const MODES = [['days', 'cal.mode.days'], ['months', 'cal.mode.months'], ['years', 'cal.mode.years']];
  const prompt = mode === 'days' ? (!draft.from ? t('cal.tap_first_day') : draft.to ? t('cal.tap_new_first') : t('cal.from_tap_last', { from: fmt(draft.from) }))
    : mode === 'months' ? (!draft.fm ? t('cal.tap_first_month') : t('cal.from_tap_last_month', { from: fmtM(draft.fm) }))
    : (!draft.fy ? t('cal.tap_first_year') : t('cal.from_tap_last_year', { from: draft.fy }));
  return (
    <View style={{ gap: 6 }}>
      {label ? <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{(label + (optional ? ' (optional)' : '')).toUpperCase()}</T> : null}
      <Pressable onPress={() => { setDraft({ from, to }); setMode('days'); setMonth((from ?? todayLocal()).slice(0, 7)); setOpen(true); }} accessibilityRole="button" accessibilityLabel={label ?? t('cal.pick_dates')} style={{ borderWidth: 1.5, borderColor: c.line, borderRadius: 12, backgroundColor: c.paper, paddingHorizontal: 16, minHeight: 50, justifyContent: 'center', flexDirection: 'row', alignItems: 'center' }}>
        <T style={{ flex: 1 }} color={from ? c.ink : c.mute} weight="600">{from ? `${fmt(from)}${to && to !== from ? ` → ${fmt(to)}` : ''}${days > 1 ? ` · ${days} days` : days === 1 ? ' · 1 day' : ''}` : t('cal.pick_dates')}</T>
        <T size={18}>📅</T>
      </Pressable>
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
      <Sheet visible={open} onClose={() => setOpen(false)} title={label ?? t('cal.pick_dates')}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityLabel={t('cal.quick')}>{PRESETS.map(([k, go]) => <Chip key={k} label={t(k)} onPress={go} />)}</View>
        <View style={{ flexDirection: 'row', gap: 8 }}>{MODES.map(([m, k]) => <Chip key={m} label={t(k)} active={mode === m} onPress={() => { setMode(m); setDraft({}); }} />)}</View>
        <T color={c.mute} size={13}>{prompt}</T>
        {mode === 'days' ? <Calendar month={month} onMonth={setMonth} range={draft} minDate={min} onChange={pick} /> : null}
        {mode === 'months' ? <MonthGrid year={Number(month.slice(0, 4))} from={draft.fm} to={draft.tm} minDate={min} onPick={pickMonth} /> : null}
        {mode === 'years' ? <YearGrid base={Number(month.slice(0, 4))} from={draft.fy} to={draft.ty} minYear={min ? Number(min.slice(0, 4)) : undefined} onPick={pickYear} /> : null}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {mode === 'days' && draft.from && !draft.to ? <Btn small title={t('cal.one_day')} color={c.violet} onPress={() => { onChange({ from: draft.from, to: draft.from }); setOpen(false); }} /> : null}
          {mode === 'months' && draft.fm && !draft.tm ? <Btn small title={t('cal.one_month')} color={c.violet} onPress={() => done(monthStart(draft.fm), monthEnd(draft.fm))} /> : null}
          {mode === 'years' && draft.fy && !draft.ty ? <Btn small title={t('cal.one_year')} color={c.violet} onPress={() => done(`${draft.fy}-01-01`, `${draft.fy}-12-31`)} /> : null}
          {optional && from ? <Btn small title={t('cal.clear')} color={c.paper} ink={c.ink} onPress={() => { onChange({ from: undefined, to: undefined }); setOpen(false); }} /> : null}
        </View>
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
export function TimeField({ label, value, onChange, optional, step = 30, hint, endOfDay }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  // The phone's own picker, except where "End of day" (24:00) must stay choosable: it only exists as a chip.
  const native = NATIVE_PICKER && !endOfDay && value !== '24:00';
  const android = native && Platform.OS === 'android';
  const start = () => {
    if (android) return openDialog({ mode: 'time', value: parseClock(value), onPick: (d) => onChange(fmtClock(d)) });
    setDraft(parseClock(value)); setOpen(true);
  };
  const times = Array.from({ length: (24 * 60) / step + 1 }, (_, i) => i * step).filter((m) => m <= 1440).map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  const fmt = (t) => { if (t === '24:00') return 'End of day'; const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 || h === 24 ? 'AM' : 'PM'}`; };
  return (
    <View style={{ gap: 6 }}>
      {label ? <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>{(label + (optional ? ' (optional)' : '')).toUpperCase()}</T> : null}
      <Pressable onPress={start} style={{ borderWidth: 1.5, borderColor: c.line, borderRadius: 12, backgroundColor: c.paper, paddingHorizontal: 16, minHeight: 50, justifyContent: 'center', flexDirection: 'row', alignItems: 'center' }}>
        <T style={{ flex: 1 }} color={value ? c.ink : c.mute} weight="600">{value ? fmt(value) : 'Pick a time'}</T><T size={18}>🕒</T>
      </Pressable>
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
      {android && optional && value ? <Btn small title="Clear" color={c.paper} ink={c.ink} onPress={() => onChange(undefined)} style={{ alignSelf: 'flex-start' }} /> : null}
      <Sheet visible={open} onClose={() => setOpen(false)} title={label ?? 'Pick a time'}>
        {native ? <>
          <NativeWheel mode="time" value={draft ?? new Date()} step={step} onChange={setDraft} />
          <Btn title="Done" onPress={() => { onChange(fmtClock(draft ?? new Date())); setOpen(false); }} />
        </> : byPartOfDay(times, (t) => Number(t.slice(0, 2))).map((g) => (
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

/** A date and a time of day in one control. value / onChange use an ISO timestamp; the person picks in their own time zone. */
export function DateTimeField({ label, value, onChange, optional, min, step = 15, hint }) {
  const d = value ? new Date(value) : null;
  const pad = (n) => String(n).padStart(2, '0');
  const date = d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : undefined;
  const time = d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : undefined;
  const put = (dt, tm) => { if (!dt) return onChange(undefined); onChange(new Date(`${dt}T${tm ?? '09:00'}:00`).toISOString()); };
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 3 }}><DateField label={label} value={date} onChange={(x) => put(x, time)} optional={optional} min={min} /></View>
        <View style={{ flex: 2 }}><TimeField label="Time" value={time} onChange={(x) => put(date ?? todayLocal(), x)} step={step} optional={optional} /></View>
      </View>
      {hint ? <T size={12} color={c.mute}>{hint}</T> : null}
    </View>
  );
}

/** − 2 + control for quantities (units, players, hours). */
export function Counter({ value, onChange, min = 1, max = 99, label, suffix, step = 1, a11y }) {
  const btn = (txt, d, off) => (
    <Pressable disabled={off} onPress={tapped(() => onChange(Math.min(max, Math.max(min, Math.round((value + d * step) * 100) / 100))))} accessibilityRole="button" accessibilityLabel={`${a11y ?? label ? `${a11y ?? label} ` : ''}${d > 0 ? 'more' : 'fewer'}`} style={{ width: 44, height: 44, borderRadius: 20, borderWidth: 1.5, borderColor: off ? c.line : c.pink, alignItems: 'center', justifyContent: 'center', opacity: off ? 0.4 : 1 }}>
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
                <T size={13} weight="700" color={done || on ? c.onAccent : c.mute}>{done ? '✓' : i + 1}</T>
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

/** Row of tall day pills (weekday over date), like a phone booking app. `avail` maps date -> 'available'|'limited'|'full'|'closed' for a dot. */
export function DayStrip({ from, count = 14, value, onChange, avail }) {
  const days = Array.from({ length: count }, (_, i) => addDays(from, i));
  return (
    <HScroll gap={8}>
      {days.map((d, i) => {
        const on = d === value, st = avail?.[d], off = st === 'full' || st === 'closed';
        const dt = new Date(`${d}T00:00:00Z`);
        return (
          <Pressable key={d} onPress={() => onChange(d)} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={dt.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}
            style={{ width: 54, paddingVertical: 10, borderRadius: 28, alignItems: 'center', gap: 6, backgroundColor: on ? c.pink : c.paper, borderWidth: 1, borderColor: on ? c.pink : c.line, opacity: off && !on ? 0.5 : 1 }}>
            <T size={11} weight="700" color={on ? '#E5EAF5' : c.mute}>{i === 0 ? 'TODAY' : dt.toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' }).toUpperCase()}</T>
            <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: on ? '#fff' : c.violetSoft, alignItems: 'center', justifyContent: 'center' }}>
              <T size={15} weight="800" color={on ? c.pink : c.ink}>{dt.getUTCDate()}</T>
            </View>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: st && !off ? (on ? '#fff' : DOT[st]) : 'transparent' }} />
          </Pressable>
        );
      })}
    </HScroll>
  );
}

export { addDays, Field };
