// The weekly timetable as a grid you paint: pick a brush (a price category, base rate, or closed), then tap or drag across the days and hours.
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useSession } from '../session';
import { Btn, Chip, T } from '../ui';
import { c } from '../theme';
import { WEEKDAYS } from '../vtime';

const ORDER = [1, 2, 3, 4, 5, 6, 0];
const CLOSED = 'closed', BASE = 'base';
const ROW_H = 26;
const mins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Everyday windows of a court → cells[weekday][row] = brush. */
function toCells(court, step) {
  const n = 1440 / step;
  const cells = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, Array(n).fill(CLOSED)]));
  for (const w of court?.windows ?? []) {
    if (w.valid_from || w.valid_to) continue;
    for (const d of w.weekdays) for (let i = Math.floor(mins(w.start) / step); i < Math.ceil(mins(w.end) / step); i++) cells[d][i] = w.category_id ?? BASE;
  }
  return cells;
}

/** cells → rows for set_weekly_timetable: runs of one brush per day, identical runs merged across days. */
export function toRows(cells, step) {
  const map = new Map();
  for (const d of ORDER) {
    let i = 0;
    while (i < cells[d].length) {
      const b = cells[d][i];
      if (b === CLOSED) { i++; continue; }
      let j = i; while (j < cells[d].length && cells[d][j] === b) j++;
      const key = `${i * step}-${j * step}-${b}`;
      if (!map.has(key)) map.set(key, { weekdays: [], start: clock(i * step), end: j * step === 1440 ? '24:00' : clock(j * step), ...(b !== BASE ? { category_id: b } : {}) });
      map.get(key).weekdays.push(d);
      i = j;
    }
  }
  return [...map.values()];
}

export function PaintGrid({ venue, data, courtIds, onSaved, saveLabel = 'Save timetable' }) {
  const { toast } = useSession();
  const first = data.courts.find((x) => x.id === courtIds[0]);
  const aligned = (first?.windows ?? []).every((w) => mins(w.start) % 60 === 0 && mins(w.end) % 60 === 0);
  const [step, setStep] = useState(aligned ? 60 : 30);
  const [cells, setCells] = useState(() => toCells(first, aligned ? 60 : 30));
  const [brush, setBrush] = useState(data.categories.find((x) => x.active)?.id ?? BASE);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const down = useRef(false);
  const box = useRef(null);
  const origin = useRef({ x: 0, y: 0, w: 0 });
  const cats = new Map(data.categories.map((x) => [x.id, x]));
  const colour = (b) => (b === CLOSED ? '#fff' : b === BASE ? '#CBD5E1' : cats.get(b)?.color ?? '#94A3B8');

  useEffect(() => { // reload from the first chosen court when the selection changes
    const f = data.courts.find((x) => x.id === courtIds[0]);
    setCells(toCells(f, step));
  }, [courtIds.join(','), step]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // a mouse released anywhere ends a drag
    if (typeof document === 'undefined') return undefined;
    const up = () => { down.current = false; setDrag(false); };
    document.addEventListener('mouseup', up); document.addEventListener('touchend', up);
    return () => { document.removeEventListener('mouseup', up); document.removeEventListener('touchend', up); };
  }, []);

  const paint = (d, i) => setCells((p) => (p[d][i] === brush ? p : { ...p, [d]: p[d].map((x, k) => (k === i ? brush : x)) }));
  const paintDay = (d) => setCells((p) => ({ ...p, [d]: p[d].map(() => brush) }));
  const paintRow = (i) => setCells((p) => Object.fromEntries(Object.entries(p).map(([d, col]) => [d, col.map((x, k) => (k === i ? brush : x))])));
  const start = (d, i) => { down.current = true; setDrag(true); paint(d, i); box.current?.measure?.((x, y, w, h, px, py) => { origin.current = { x: px, y: py, w }; }); };
  const touchMove = (e) => { // finger drag on phones/tablets: map the touch point to a cell
    if (!down.current) return;
    const t = e.nativeEvent.touches?.[0] ?? e.nativeEvent;
    const { x, y, w } = origin.current; const labelW = 44;
    const col = Math.floor(((t.pageX - x - labelW) / (w - labelW)) * 7), row = Math.floor((t.pageY - y - ROW_H) / ROW_H);
    if (col >= 0 && col < 7 && row >= 0 && row < cells[0].length) paint(ORDER[col], row);
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/venues/${venue.id}/timetable/weekly`, { resource_ids: courtIds, rows: toRows(cells, step) });
      toast(`Timetable saved for ${courtIds.length} court${courtIds.length > 1 ? 's' : ''}`); onSaved?.();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };

  const hours = cells[0].length;
  return (
    <View style={{ gap: 10 }}>
      <T weight="800" size={13}>1 · Pick a brush</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {data.categories.filter((x) => x.active).map((x) => (
          <Pressable key={x.id} onPress={() => setBrush(x.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 16, borderWidth: 2, borderColor: brush === x.id ? c.ink : c.line, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: c.paper }}>
            <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: x.color }} /><T size={13} weight="700">{x.name}</T>
          </Pressable>
        ))}
        <Pressable onPress={() => setBrush(BASE)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 16, borderWidth: 2, borderColor: brush === BASE ? c.ink : c.line, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: c.paper }}><View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: '#CBD5E1' }} /><T size={13} weight="700">Base rate</T></Pressable>
        <Pressable onPress={() => setBrush(CLOSED)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 16, borderWidth: 2, borderColor: brush === CLOSED ? c.ink : c.line, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: c.paper }}><View style={{ width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: '#94A3B8', backgroundColor: '#fff' }} /><T size={13} weight="700">Closed (erase)</T></Pressable>
      </View>
      <T weight="800" size={13}>2 · Tap or drag across the grid</T>
      <T size={12} color={c.mute}>Tap a day name to paint the whole day, or an hour to paint it across the week.</T>
      <View ref={box} onTouchMove={touchMove} style={{ borderWidth: 1, borderColor: c.line, borderRadius: 12, overflow: 'hidden', backgroundColor: c.paper }}>
        <View style={{ flexDirection: 'row', height: ROW_H, alignItems: 'center', backgroundColor: c.violetSoft }}>
          <View style={{ width: 44 }} />
          {ORDER.map((d) => <Pressable key={d} onPress={() => paintDay(d)} style={{ flex: 1, alignItems: 'center' }}><T size={12} weight="800">{WEEKDAYS[d]}</T></Pressable>)}
        </View>
        <ScrollView style={{ maxHeight: 440 }} scrollEnabled={!drag} nestedScrollEnabled>
          {Array.from({ length: hours }, (_, i) => (
            <View key={i} style={{ flexDirection: 'row', height: ROW_H, borderTopWidth: i % (60 / step) === 0 ? 1 : 0, borderColor: c.line }}>
              <Pressable onPress={() => paintRow(i)} style={{ width: 44, justifyContent: 'center', paddingLeft: 6 }}>{(i * step) % 60 === 0 ? <T size={11} color={c.mute}>{clock(i * step).replace(/^0/, '')}</T> : null}</Pressable>
              {ORDER.map((d) => (
                <Pressable key={d} onPressIn={() => start(d, i)} onHoverIn={() => { if (down.current) paint(d, i); }} style={{ flex: 1, backgroundColor: colour(cells[d][i]), borderLeftWidth: 1, borderColor: 'rgba(15,23,42,0.08)' }} />
              ))}
            </View>
          ))}
        </ScrollView>
      </View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip label="1 hour rows" active={step === 60} onPress={() => setStep(60)} /><Chip label="30 min rows" active={step === 30} onPress={() => setStep(30)} />
        <Btn small title="Clear all" color={c.paper} onPress={() => setCells(toCells(null, step))} />
      </View>
      <Btn title={saveLabel} onPress={save} loading={busy} disabled={!courtIds.length} />
    </View>
  );
}
