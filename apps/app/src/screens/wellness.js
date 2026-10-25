import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import Svg, { Circle, Ellipse, Rect } from 'react-native-svg';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Field, Loading, Seg, Sheet, T } from '../ui';
import { Counter, HScroll } from '../pickers';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { todayIn } from '../vtime';
import { saveDraft, saveMessage } from '../offline';
import { LoadHistory } from './load-history';

const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const nice = (s) => String(s).replace(/_/g, ' ');
const BAND = { ready: [c.mint, 'Ready to go'], moderate: [c.sun, 'Take it steady'], rest: [c.red, 'Prioritise recovery'] };
const MOODS = [[1, '😞', 'Low'], [2, '🙁', 'Down'], [3, '😐', 'Okay'], [4, '🙂', 'Good'], [5, '😄', 'Great']];

// ---------- readiness ----------

export function useReadiness() {
  return useLoad(() => api.get('/me/readiness', { date: todayIn(deviceTz) }), []);
}

/** The daily readiness ring: sleep + recovery + soreness. Empty until the athlete logs something; never a made-up number. */
export function ReadinessRing({ score, band, size = 120 }) {
  const stroke = 12, r = (size - stroke) / 2, circ = 2 * Math.PI * r;
  const col = (BAND[band] ?? [c.line])[0];
  return (
    <View accessible accessibilityLabel={score === null ? 'Readiness not logged yet' : `Readiness ${score} out of 100`} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={c.line} strokeWidth={stroke} fill="none" />
        {score !== null ? <Circle cx={size / 2} cy={size / 2} r={r} stroke={col} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={`${(circ * score) / 100} ${circ}`} rotation="-90" origin={`${size / 2}, ${size / 2}`} /> : null}
      </Svg>
      <T weight="800" size={size / 3} style={{ letterSpacing: -1 }}>{score === null ? '–' : score}</T>
      <T size={11} weight="700" color={c.mute}>READINESS</T>
    </View>
  );
}

/** Home / Health summary of today's readiness with the three things it is made of. */
export function ReadinessCard({ rd, onLog, onOpen }) {
  const d = rd.data;
  if (rd.error) return <ErrorBox error={rd.error} onRetry={rd.reload} />;
  if (!d) return <Card><Loading /></Card>;
  const [col, label] = BAND[d.band] ?? [c.mute, 'Log how you feel'];
  const names = { sleep: 'Sleep', soreness: 'Soreness', mood: 'Mood' };
  return (
    <Card onPress={onOpen} pad={16}>
      <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center' }}>
        <ReadinessRing score={d.score} band={d.band} size={104} />
        <View style={{ flex: 1, gap: 6 }}>
          <T weight="800" size={17} color={d.score === null ? c.ink : col}>{d.score === null ? 'How are you today?' : label}</T>
          {d.score === null ? <T size={13} color={c.mute}>Log sleep, soreness or mood and your readiness appears here.</T> : (
            <View style={{ gap: 3 }}>{d.factors.map((f) => <T key={f.key} size={12} color={c.mute}>{names[f.key]}: <T size={12} weight="700" color={c.ink}>{f.value === null ? 'not logged' : `${f.value}%`}</T></T>)}</View>
          )}
          {d.workload?.status === 'caution' || d.workload?.status === 'high' ? <T size={12} weight="700" color={c.red}>Workload is {d.workload.status} ({d.workload.ratio})</T> : null}
          {d.open_pain ? <T size={12} color={c.mute}>{d.open_pain} open body-map {d.open_pain === 1 ? 'entry' : 'entries'}</T> : null}
          <Btn small title={d.logged ? 'Update today’s log' : 'Log how I feel'} onPress={onLog} style={{ alignSelf: 'flex-start', marginTop: 4 }} />
        </View>
      </View>
    </Card>
  );
}

// ---------- quick log ----------

/** One sheet for the fast logs: water, sleep, mood, soreness, and a private note. Each saves on its own. */
export function QuickLogSheet({ visible, onClose, onDone }) {
  const { toast } = useSession();
  const [hours, setHours] = useState(7.5), [quality, setQuality] = useState(null), [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (body, msg) => {
    setBusy(true);
    try { await api.post('/me/wellness', { date: todayIn(deviceTz), ...body }); toast(msg); await onDone?.(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const row = { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' };
  return (
    <Sheet visible={visible} onClose={onClose} title="Quick log">
      <View style={{ gap: 18 }}>
        <View style={{ gap: 8 }}>
          <T weight="800">💧 Water</T>
          <View style={row}>{[250, 500, 750].map((ml) => <Btn key={ml} small disabled={busy} color={c.paper} ink={c.ink} title={`+${ml} ml`} onPress={() => save({ water_add_ml: ml }, `Added ${ml} ml`)} />)}</View>
        </View>
        <View style={{ gap: 8 }}>
          <T weight="800">🙂 Mood</T>
          <View style={row}>{MOODS.map(([v, e, l]) => <Chip key={v} label={`${e} ${l}`} onPress={() => save({ mood: v }, 'Mood logged')} />)}</View>
        </View>
        <View style={{ gap: 8 }}>
          <T weight="800">💪 Soreness <T size={12} color={c.mute}>0 = fresh, 10 = very sore</T></T>
          <HScroll>{Array.from({ length: 11 }, (_, v) => <Chip key={v} label={String(v)} onPress={() => save({ soreness: v }, 'Soreness logged')} />)}</HScroll>
        </View>
        <View style={{ gap: 8 }}>
          <T weight="800">😴 Last night’s sleep</T>
          <Counter value={hours} onChange={setHours} min={0} max={14} step={0.5} suffix=" h" />
          <View style={row}>{[1, 2, 3, 4, 5].map((q) => <Chip key={q} label={`${'★'.repeat(q)}`} active={quality === q} onPress={() => setQuality(quality === q ? null : q)} />)}</View>
          <Btn small disabled={busy} title="Save sleep" onPress={() => save({ sleep_hours: hours, ...(quality ? { sleep_quality: quality } : {}) }, 'Sleep logged')} style={{ alignSelf: 'flex-start' }} />
        </View>
        <View style={{ gap: 8 }}>
          <T weight="800">📝 Private note</T>
          <Field value={note} onChangeText={setNote} placeholder="Anything worth remembering today" multiline />
          <Btn small disabled={busy || !note.trim()} color={c.paper} ink={c.ink} title="Save note" onPress={async () => { await save({ note: note.trim() }, 'Note saved (encrypted)'); setNote(''); }} style={{ alignSelf: 'flex-start' }} />
        </View>
      </View>
    </Sheet>
  );
}

/** Floating quick-log button for the home screen. */
export function QuickLogFab({ onPress, bottom = 96 }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Quick log" onPress={onPress} style={{ position: 'absolute', right: 18, bottom, width: 56, height: 56, borderRadius: 28, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 6 }}>
      <T size={28} weight="700" color={c.onAccent}>＋</T>
    </Pressable>
  );
}

// ---------- body map ----------

// Front and back silhouettes built from tappable shapes in a 200x420 box. `viewer` sides are mirrored for the front view
// (the viewer's left is the person's right) so what is saved is always the athlete's own left or right.
const ARM = (v) => [
  ['upper_arm', v, { t: 'rect', x: v === 'L' ? 38 : 142, y: 90, w: 20, h: 52 }], ['elbow', v, { t: 'ellipse', cx: v === 'L' ? 48 : 152, cy: 148, rx: 10, ry: 8 }],
  ['forearm', v, { t: 'rect', x: v === 'L' ? 34 : 148, y: 156, w: 18, h: 50 }], ['hand', v, { t: 'ellipse', cx: v === 'L' ? 40 : 160, cy: 218, rx: 10, ry: 13 }],
  ['shoulder', v, { t: 'ellipse', cx: v === 'L' ? 64 : 136, cy: 76, rx: 20, ry: 14 }],
];
const LEG = (v, shin) => [
  ['knee', v, { t: 'ellipse', cx: v === 'L' ? 85 : 115, cy: 272, rx: 13, ry: 11 }], [shin, v, { t: 'rect', x: v === 'L' ? 74 : 104, y: 286, w: 22, h: 70 }],
  ['ankle', v, { t: 'ellipse', cx: v === 'L' ? 85 : 115, cy: 364, rx: 9, ry: 7 }], ['foot', v, { t: 'ellipse', cx: v === 'L' ? 85 : 115, cy: 386, rx: 12, ry: 10 }],
];
const FRONT = [
  ['head', null, { t: 'ellipse', cx: 100, cy: 28, rx: 18, ry: 22 }], ['neck', null, { t: 'rect', x: 92, y: 50, w: 16, h: 14 }],
  ['chest', null, { t: 'rect', x: 72, y: 64, w: 56, h: 40 }], ['abdomen', null, { t: 'rect', x: 76, y: 106, w: 48, h: 44 }],
  ...ARM('L'), ...ARM('R'),
  ['hip', 'L', { t: 'rect', x: 70, y: 152, w: 28, h: 26 }], ['hip', 'R', { t: 'rect', x: 102, y: 152, w: 28, h: 26 }], ['groin', null, { t: 'rect', x: 93, y: 180, w: 14, h: 12 }],
  ['thigh_front', 'L', { t: 'rect', x: 72, y: 194, w: 26, h: 68 }], ['thigh_front', 'R', { t: 'rect', x: 102, y: 194, w: 26, h: 68 }],
  ...LEG('L', 'shin'), ...LEG('R', 'shin'),
];
const BACK = [
  ['head', null, { t: 'ellipse', cx: 100, cy: 28, rx: 18, ry: 22 }], ['neck', null, { t: 'rect', x: 92, y: 50, w: 16, h: 14 }],
  ['upper_back', null, { t: 'rect', x: 72, y: 64, w: 56, h: 42 }], ['lower_back', null, { t: 'rect', x: 76, y: 108, w: 48, h: 38 }],
  ...ARM('L'), ...ARM('R'),
  ['glute', 'L', { t: 'rect', x: 72, y: 148, w: 27, h: 32 }], ['glute', 'R', { t: 'rect', x: 101, y: 148, w: 27, h: 32 }],
  ['hamstring', 'L', { t: 'rect', x: 72, y: 194, w: 26, h: 68 }], ['hamstring', 'R', { t: 'rect', x: 102, y: 194, w: 26, h: 68 }],
  ...LEG('L', 'calf'), ...LEG('R', 'calf'),
];

const sevColor = (s) => (s >= 7 ? c.red : s >= 4 ? c.orange : c.sun);
export const sideName = (s) => (s === 'left' ? 'Left ' : s === 'right' ? 'Right ' : '');
export const regionName = (r, side) => `${sideName(side)}${nice(r)}`;
const KINDS = [{ value: 'pain', label: 'Pain' }, { value: 'tightness', label: 'Tightness' }, { value: 'fatigue', label: 'Fatigue' }];

/** Tap a body part, rate it 1-10. Open entries colour the map; each can be marked better. Notes are private and encrypted. */
export function BodyMap({ pain, onChanged }) {
  const { toast } = useSession();
  const [view, setView] = useState('front');
  const [pick, setPick] = useState(null); // { region, side }
  const open = pain.data ?? [];
  const shapes = view === 'front' ? FRONT : BACK;
  const sideOf = (v) => (v === null ? 'centre' : (view === 'front') === (v === 'L') ? 'right' : 'left'); // front view mirrors
  const worst = (region, side) => Math.max(0, ...open.filter((p) => p.region === region && p.side === side).map((p) => p.severity));
  const existing = pick ? open.find((p) => p.region === pick.region && p.side === pick.side) : null;
  return (
    <View style={{ gap: 12 }}>
      <Seg options={[{ value: 'front', label: 'Front' }, { value: 'back', label: 'Back' }]} value={view} onChange={setView} color={c.pink} />
      <View style={{ alignItems: 'center' }}>
        <Svg width={220} height={462} viewBox="0 0 200 420" accessibilityLabel={`Body map, ${view} view`}>
          {shapes.map(([region, v, g], i) => {
            const side = sideOf(v), sev = worst(region, side);
            const fill = sev ? sevColor(sev) : c.pinkSoft;
            const common = { fill, fillOpacity: sev ? 0.85 : 1, stroke: c.line, strokeWidth: 1.5, onPress: () => setPick({ region, side }) };
            const key = `${region}${v}${i}`;
            return g.t === 'rect' ? <Rect key={key} {...common} x={g.x} y={g.y} width={g.w} height={g.h} rx={8} /> : <Ellipse key={key} {...common} cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} />;
          })}
        </Svg>
        <T size={12} color={c.mute}>Tap where it hurts. Colour shows how bad: yellow mild, orange moderate, red severe.</T>
      </View>
      {open.length ? (
        <View style={{ gap: 8 }}>
          <T weight="800">Current ({open.length})</T>
          {open.map((p) => (
            <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: sevColor(p.severity) }} />
              <T style={{ flex: 1 }} weight="600">{regionName(p.region, p.side)} · {p.kind} {p.severity}/10{p.note ? ` · ${p.note}` : ''}</T>
              <Btn small color={c.paper} ink={c.ink} title="Better" onPress={async () => { try { await api.post(`/me/body-pain/${p.id}/resolve`); toast('Marked as better'); await onChanged(); } catch (e) { toast(e.message); } }} />
            </View>
          ))}
        </View>
      ) : <T size={13} color={c.mute}>Nothing flagged. Tap the body to log an ache, tightness or fatigue.</T>}
      {pick ? (
        <FormSheet visible onClose={() => setPick(null)} title={regionName(pick.region, pick.side)} submitLabel="Save"
          initial={{ kind: existing?.kind ?? 'pain', severity: existing?.severity ?? 3, note: '' }}
          fields={[
            { key: 'kind', label: 'What does it feel like', type: 'chips', options: KINDS },
            { key: 'severity', label: 'How bad (1 mild – 10 severe)', type: 'stepper', min: 1, max: 10 },
            { key: 'note', label: 'Private note', optional: true, type: 'multiline' },
          ]}
          onSubmit={async (v) => { await api.post('/me/body-pain', { region: pick.region, side: pick.side, kind: v.kind, severity: Number(v.severity), ...(v.note ? { note: v.note } : {}) }); await onChanged(); return 'Saved'; }} />
      ) : null}
    </View>
  );
}

// ---------- workload ----------

const ZONES = [[0, 0.8, c.sun, 'Low'], [0.8, 1.3, c.mint, 'Optimal'], [1.3, 1.5, c.orange, 'Caution'], [1.5, 2, c.red, 'High']];
const STATUS_TEXT = { no_data: 'Log a few sessions to see your workload.', building: 'Keep logging: the ratio needs three weeks of sessions.', low: 'Load is below your usual. Fine for a deload, risky if it is a long gap.', optimal: 'In the sweet spot: building without spiking.', caution: 'Load is climbing faster than your body is used to. Watch recovery.', high: 'A big jump versus your recent weeks. Consider an easier session.' };

export function WorkloadCard({ wl, onChanged }) {
  const [log, setLog] = useState(false);
  const d = wl.data;
  const max = d ? Math.max(1, ...d.weeks.map((w) => w.load)) : 1;
  const W = 280, H = 70;
  return (
    <Card pad={16}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T weight="800" size={16}>Training load</T>
        <Btn small title="+ Log session" onPress={() => setLog(true)} />
      </View>
      {wl.error ? <ErrorBox error={wl.error} onRetry={wl.reload} /> : !d ? <Loading /> : (
        <View style={{ gap: 12, marginTop: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <T weight="800" size={30} style={{ letterSpacing: -1 }}>{d.ratio ?? '–'}</T>
            <T size={12} color={c.mute} weight="700">ACUTE : CHRONIC</T>
          </View>
          <View accessible accessibilityLabel={`Workload ratio ${d.ratio ?? 'not available'}, ${d.status}`}>
            <Svg width="100%" height={22} viewBox="0 0 280 22" preserveAspectRatio="none">
              {ZONES.map(([a, b, col]) => <Rect key={a} x={(a / 2) * 280} y={6} width={((b - a) / 2) * 280} height={10} fill={col} fillOpacity={0.9} />)}
              {d.ratio !== null ? <Rect x={Math.min(276, (Math.min(d.ratio, 2) / 2) * 280 - 2)} y={0} width={4} height={22} rx={2} fill={c.ink} /> : null}
            </Svg>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>{ZONES.map(([, , col, l]) => <T key={l} size={10} color={c.mute}>{l}</T>)}</View>
          </View>
          <T size={13} color={c.mute}>{STATUS_TEXT[d.status]}</T>
          {d.weeks.some((w) => w.load) ? (
            <View>
              <T size={11} weight="700" color={c.mute}>WEEKLY LOAD · LAST 8 WEEKS</T>
              <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" accessibilityLabel={`Weekly load, last 8 weeks: ${d.weeks.map((w) => w.load).join(', ')}`}>
                {d.weeks.map((w, i) => { const h = Math.max(2, (w.load / max) * (H - 6)); return <Rect key={w.week_ending} x={i * 35 + 4} y={H - h} width={27} height={h} rx={4} fill={i === 7 ? c.pink : c.pinkSoft} />; })}
              </Svg>
            </View>
          ) : null}
        </View>
      )}
      {log ? (
        <FormSheet visible onClose={() => setLog(false)} title="Log a session" submitLabel="Save session"
          initial={{ kind: 'training', date: todayIn(deviceTz), minutes: 60, rpe: 5 }}
          fields={[
            { key: 'kind', label: 'What was it', type: 'chips', options: [{ value: 'training', label: 'Training' }, { value: 'match', label: 'Match' }, { value: 'gym', label: 'Gym' }, { value: 'other', label: 'Other' }] },
            { key: 'date', label: 'Day', type: 'date', max: todayIn(deviceTz) },
            { key: 'minutes', label: 'How long', type: 'stepper', min: 5, max: 300, step: 5, suffix: ' min' },
            { key: 'rpe', label: 'How hard it felt (1 easy – 10 maximal)', type: 'stepper', min: 1, max: 10 },
          ]}
          onSubmit={async (v) => { const r = await saveDraft({ kind: 'load_log', payload: { data: { date: v.date, kind: v.kind, minutes: Number(v.minutes), rpe: Number(v.rpe) } }, label: `${v.kind[0].toUpperCase()}${v.kind.slice(1)} · ${v.minutes} min`, sub: v.date }); await onChanged(); return saveMessage(r, 'Session logged'); }} />
      ) : null}
    </Card>
  );
}

// ---------- sleep & hydration ----------

function Bars({ title, unit, rows, pick, goal, fmt = (v) => v }) {
  const W = 280, H = 60;
  const vals = rows.map(pick);
  const max = Math.max(goal, ...vals.map((v) => v ?? 0), 1);
  return (
    <View style={{ flex: 1, minWidth: 240 }}>
      <T size={11} weight="700" color={c.mute}>{title}</T>
      <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" accessibilityLabel={`${title}: ${vals.map((v) => (v === null ? 'none' : fmt(v))).join(', ')}`}>
        <Rect x={0} y={H - (goal / max) * (H - 6)} width={W} height={1} fill={c.line} />
        {vals.map((v, i) => { const h = v === null ? 0 : Math.max(2, (v / max) * (H - 6)); return <Rect key={rows[i].date} x={i * 40 + 6} y={H - h} width={28} height={h} rx={4} fill={v !== null && v >= goal ? c.mint : c.cyan} />; })}
      </Svg>
      <T size={11} color={c.mute}>Last 7 days · line = {fmt(goal)}{unit}</T>
    </View>
  );
}

export function SleepHydration({ hist }) {
  if (hist.error) return <ErrorBox error={hist.error} onRetry={hist.reload} />;
  if (!hist.data) return <Loading />;
  const byDate = new Map(hist.data.map((r) => [r.log_date, r]));
  const rows = Array.from({ length: 7 }, (_, i) => { const d = new Date(Date.parse(`${todayIn(deviceTz)}T00:00:00Z`) - (6 - i) * 86400000).toISOString().slice(0, 10); return { date: d, ...(byDate.get(d) ?? {}) }; });
  if (!hist.data.length) return <Empty emoji="💧" title="No sleep or water logged yet" sub="Use the quick log to add sleep, water, mood and soreness." />;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
      <Bars title="SLEEP (HOURS)" unit=" h" rows={rows} pick={(r) => (r.sleep_hours == null ? null : Number(r.sleep_hours))} goal={8} />
      <Bars title="WATER (LITRES)" unit=" L" rows={rows} pick={(r) => (r.water_ml == null ? null : r.water_ml / 1000)} goal={2.5} fmt={(v) => Math.round(v * 10) / 10} />
    </View>
  );
}

// ---------- the Recovery panel (Health tab) ----------

export function RecoveryPanel() {
  const [quick, setQuick] = useState(false);
  const rd = useReadiness();
  const pain = useLoad(() => api.get('/me/body-pain'), []);
  const wl = useLoad(() => api.get('/me/workload', { date: todayIn(deviceTz) }), []);
  const hist = useLoad(() => api.get('/me/wellness'), []);
  const [ver, setVer] = useState(0);
  const all = async () => { setVer((x) => x + 1); await Promise.all([rd.reload(), pain.reload(), wl.reload(), hist.reload()]); };
  return (
    <View style={{ gap: 16 }}>
      <ReadinessCard rd={rd} onLog={() => setQuick(true)} />
      <Card pad={16}><T weight="800" size={16} style={{ marginBottom: 10 }}>Body map</T>{pain.error ? <ErrorBox error={pain.error} onRetry={pain.reload} /> : <BodyMap pain={pain} onChanged={all} />}</Card>
      <WorkloadCard wl={wl} onChanged={all} />
      <LoadHistory version={ver} onChanged={all} />
      <Card pad={16}><T weight="800" size={16} style={{ marginBottom: 10 }}>Sleep & hydration</T><SleepHydration hist={hist} /></Card>
      <T size={12} color={c.mute}>Only you can see this. Notes are encrypted and every read is logged. Readiness is guidance, not medical advice; see a physio or doctor for pain that does not settle.</T>
      <QuickLogSheet visible={quick} onClose={() => setQuick(false)} onDone={all} />
    </View>
  );
}
