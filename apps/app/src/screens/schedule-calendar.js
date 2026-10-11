import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useSession } from '../session';
import { Btn, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { shiftMonth } from '../pickers';
import { c } from '../theme';
import { localDate, localToIso, todayIn, WEEKDAYS } from '../vtime';
import { locale } from '../locale';

const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const DOT = { match: c.red, team: c.red, training: c.cyan, health: c.mint, recovery: c.mint, event: c.sun, venue: c.mute, duty: c.mute };

/** In / Maybe / Out for a team commitment. Uses the team attendance answer behind the scenes (going / maybe / no); managers are told on "Out". */
const ANSWERS = [['going', 'In'], ['maybe', 'Maybe'], ['no', 'Out']];
export function RsvpBar({ x, reload }) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const r = x.rsvp;
  if (!r) return null;
  const answer = async (rsvp) => {
    setBusy(true);
    try {
      await api.post(`/teams/${r.team_id}/attendance`, { ...(r.fixture_id ? { fixture_id: r.fixture_id } : { event_id: r.event_id }), rsvp });
      toast(rsvp === 'going' ? "You're in" : rsvp === 'maybe' ? 'Marked as maybe' : 'Marked as out — your manager is told');
      await reload();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <T size={12} weight="700" color={c.mute}>Are you coming?</T>
      {ANSWERS.map(([v, l]) => {
        const on = r.value === v;
        return (
          <Pressable key={v} disabled={busy} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => answer(v)}
            style={{ paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1.5, borderColor: on ? (v === 'going' ? c.mint : v === 'maybe' ? c.sun : c.red) : c.line, backgroundColor: on ? (v === 'going' ? c.mintSoft : v === 'maybe' ? c.sunSoft : c.redSoft) : 'transparent' }}>
            <T size={13} weight="700" color={on ? c.ink : c.mute}>{l}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Month at a glance: a dot per kind of commitment on each day; tap a day to see it. `items` come from the schedule projection. */
export function MonthGrid({ month, onMonth, items, selected, onSelect }) {
  const [y, mo] = month.split('-').map(Number);
  const today = todayIn(deviceTz);
  const lead = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const byDay = useMemo(() => {
    const m = new Map();
    for (const x of items) {
      const d = localDate(x.starts_at, x.all_day ? 'UTC' : deviceTz);
      const set = m.get(d) ?? new Set();
      set.add(x.kind); m.set(d, set);
    }
    return m;
  }, [items]);
  const cells = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  while (cells.length % 7) cells.push(null);
  const title = new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <Pressable onPress={() => onMonth(shiftMonth(month, -1))} hitSlop={10} accessibilityLabel="Previous month" style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}><T size={22} weight="700">‹</T></Pressable>
        <T weight="700" size={16}>{title}</T>
        <Pressable onPress={() => onMonth(shiftMonth(month, 1))} hitSlop={10} accessibilityLabel="Next month" style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}><T size={22} weight="700">›</T></Pressable>
      </View>
      <View style={{ flexDirection: 'row' }}>{WEEKDAYS.map((w) => <View key={w} style={{ width: `${100 / 7}%`, alignItems: 'center', paddingBottom: 6 }}><T size={11} color={c.mute} weight="700">{w.toUpperCase()}</T></View>)}</View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {cells.map((d, i) => {
          if (!d) return <View key={`b${i}`} style={{ width: `${100 / 7}%`, height: 52 }} />;
          const kinds = [...(byDay.get(d) ?? [])];
          const on = selected === d;
          return (
            <Pressable key={d} onPress={() => onSelect(d)} accessibilityLabel={`${d}${kinds.length ? `, ${kinds.length} kinds of commitment` : ', nothing scheduled'}`} style={{ width: `${100 / 7}%`, height: 52, padding: 2 }}>
              <View style={{ flex: 1, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? c.pink : 'transparent', borderWidth: d === today && !on ? 1.5 : 0, borderColor: c.pink }}>
                <T weight="700" size={15} color={on ? '#fff' : c.ink}>{Number(d.slice(8))}</T>
                <View style={{ flexDirection: 'row', gap: 3, height: 6, marginTop: 2 }}>
                  {kinds.slice(0, 3).map((k) => <View key={k} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: on ? '#fff' : DOT[k] ?? c.mute }} />)}
                </View>
              </View>
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', gap: 14, marginTop: 8, flexWrap: 'wrap' }}>
        {[[c.red, 'Match'], [c.cyan, 'Training'], [c.mint, 'Recovery / health'], [c.sun, 'Event']].map(([col, l]) => <View key={l} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: col }} /><T size={11} color={c.mute}>{l}</T></View>)}
      </View>
    </View>
  );
}

const KIND_OPTIONS = [{ value: 'recovery', label: '🧘 Recovery' }, { value: 'gym', label: '🏋️ Gym' }, { value: 'rest', label: '😴 Rest' }, { value: 'other', label: 'Other' }];

/** Block out personal time (recovery, gym, rest) on your own calendar. Pickers for date and times; the title is optional. */
export function BlockSheet({ visible, onClose, onDone, date }) {
  return (
    <FormSheet visible={visible} onClose={onClose} title="Block out time" submitLabel="Add to my calendar"
      initial={{ kind: 'recovery', date: date ?? todayIn(deviceTz), start: '10:00', end: '11:00' }}
      fields={[
        { key: 'kind', label: 'What is it', type: 'chips', options: KIND_OPTIONS },
        { key: 'date', label: 'Day', type: 'date' },
        { key: 'start', label: 'From', type: 'time', step: 15 },
        { key: 'end', label: 'Until', type: 'time', step: 15 },
        { key: 'title', label: 'Label', optional: true, placeholder: 'Ice bath, mobility, leg day…' },
      ]}
      onSubmit={async (v) => {
        if (!v.date || !v.start || !v.end) throw new Error('Pick the day and both times');
        if (v.end <= v.start) throw new Error('The end time must be after the start');
        await api.post('/me/blocks', { kind: v.kind, title: v.title || undefined, starts_at: localToIso(v.date, v.start, deviceTz), ends_at: localToIso(v.date, v.end === '24:00' ? '23:59' : v.end, deviceTz), timezone: deviceTz });
        await onDone();
        return 'Added to your calendar';
      }} />
  );
}

export function AddBlockButton({ onPress }) {
  return <Btn small title="+ Block time" color={c.paper} ink={c.ink} onPress={onPress} />;
}
