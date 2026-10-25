import React from 'react';
import { Linking, Platform, View } from 'react-native';
import { T, Tag } from '../ui';
import { c } from '../theme';

// Structured workouts (issue #326). Units on the wire are metres, seconds, kilograms and watts; this file only formats them.
export const BLOCK_KINDS = [
  { value: 'warmup', label: 'Warm-up' }, { value: 'work', label: 'Main work' }, { value: 'interval', label: 'Intervals' },
  { value: 'strength', label: 'Strength' }, { value: 'rest', label: 'Rest' }, { value: 'cooldown', label: 'Cool-down' },
];
const KIND_LABEL = Object.fromEntries(BLOCK_KINDS.map((k) => [k.value, k.label]));

export const fmtDist = (m) => (m >= 1000 ? `${Math.round(m / 10) / 100} km` : `${m} m`);
export const fmtTime = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} min` : `${s} s`);
const perLabel = (per) => (per === 1000 ? '/km' : `/${per} m`);
export const fmtPace = (s, per = 1000) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} ${perLabel(per)}`;

export function describeBlock(b, rules) {
  if (b.kind === 'rest') return `Rest ${fmtTime(b.rest_sec)}`;
  const reps = b.reps ? `${b.reps} reps` : null;
  const work = b.work_m ? fmtDist(b.work_m) : b.work_sec ? fmtTime(b.work_sec) : null;
  const head = b.sets && (work || reps) ? `${b.sets} × ${[reps, work].filter(Boolean).join(' × ')}` : [b.sets ? `${b.sets} sets` : null, reps, work].filter(Boolean).join(' · ');
  const z = b.zone ? (() => {
    const unit = b.zone.kind === 'pace' ? (v) => fmtPace(v, rules?.pace_per_m) : (v) => `${v} W`;
    const range = b.zone.min !== undefined && b.zone.max !== undefined ? ` (${unit(b.zone.min)} – ${unit(b.zone.max)})` : b.zone.min !== undefined ? ` (from ${unit(b.zone.min)})` : b.zone.max !== undefined ? ` (up to ${unit(b.zone.max)})` : '';
    return `${b.zone.kind} zone ${b.zone.level}${range}`;
  })() : null;
  return [head, b.load_kg ? `${b.load_kg} kg` : null, z, b.rest_sec ? `rest ${fmtTime(b.rest_sec)}` : null].filter(Boolean).join(' · ');
}

/** The planned blocks of a session, read-only. `onRemove(i)` adds a remove link when the coach is editing a draft. */
export function WorkoutPlan({ blocks, rules, onRemove }) {
  if (!blocks?.length) return null;
  return (
    <View style={{ gap: 6, marginTop: 6 }} accessibilityLabel="Workout plan">
      {blocks.map((b, i) => (
        <View key={b.id} style={{ borderLeftWidth: 3, borderLeftColor: b.kind === 'rest' ? c.line : c.pink, paddingLeft: 10, gap: 2 }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <T weight="700" size={13} style={{ flexShrink: 1 }}>{b.label}</T><Tag label={KIND_LABEL[b.kind]} />
            {onRemove ? <T size={12} color={c.red} weight="700" accessibilityRole="button" accessibilityLabel={`Remove ${b.label}`} onPress={() => onRemove(i)}>Remove</T> : null}
          </View>
          <T size={12} color={c.mute}>{describeBlock(b, rules)}</T>
          {b.notes ? <T size={12}>{b.notes}</T> : null}
          {b.demo ? <T size={12} color={c.violet} weight="700" accessibilityRole="link" onPress={() => Linking.openURL(b.demo.url).catch(() => {})}>▶ {b.demo.title || 'Watch the demonstration'}</T> : null}
        </View>
      ))}
    </View>
  );
}

const num = (v) => Number(v ?? 0);

/** Fields for adding one block. Zero means "not used" for the optional numbers. */
export const blockFields = (rules) => [
  { key: 'kind', label: 'Block type', type: 'chips', options: BLOCK_KINDS, default: 'work' },
  { key: 'label', label: 'Name (e.g. Back squat, 800 m repeats)' },
  { key: 'sets', label: 'Sets or repetitions', type: 'stepper', min: 0, max: 50, step: 1, default: 0, hint: '0 = not used', show: (v) => v.kind !== 'rest' },
  { key: 'reps', label: 'Reps per set', type: 'stepper', min: 0, max: 500, step: 1, default: 0, hint: '0 = not used', show: (v) => v.kind !== 'rest' },
  { key: 'load_kg', label: 'Load (kg)', type: 'stepper', min: 0, max: 1000, step: 2.5, default: 0, hint: '0 = bodyweight / not used', show: (v) => ['strength', 'work'].includes(v.kind) },
  { key: 'measure', label: 'Each set is measured by', type: 'chips', options: [{ value: 'none', label: 'Just reps' }, { value: 'distance', label: 'Distance' }, { value: 'time', label: 'Time' }], default: 'none', show: (v) => v.kind !== 'rest' && v.kind !== 'strength' },
  { key: 'work_m', label: 'Distance of each set (metres)', type: 'stepper', min: 50, max: 200000, step: 50, default: 400, show: (v) => v.kind !== 'rest' && v.measure === 'distance' },
  { key: 'work_sec', label: 'Time of each set (seconds)', type: 'stepper', min: 15, max: 21600, step: 30, default: 60, show: (v) => v.kind !== 'rest' && v.measure === 'time' },
  { key: 'rest_sec', label: 'Rest (seconds)', type: 'stepper', min: 0, max: 3600, step: 15, default: 60, hint: 'After each set; for a rest block, how long it lasts', show: (v) => v.kind !== 'warmup' && v.kind !== 'cooldown' },
  { key: 'zone', label: 'Training zone', type: 'chips', optional: true, show: (v) => v.kind !== 'rest' && v.measure !== 'none' && (rules?.pace || rules?.power),
    options: [...(rules?.pace ? [{ value: 'pace', label: 'Pace zone' }] : []), ...(rules?.power ? [{ value: 'power', label: 'Power zone' }] : [])], hint: 'Only the zones this sport records are offered' },
  { key: 'zone_level', label: 'Zone (1 easy – 5 maximal)', type: 'stepper', min: 1, max: 5, step: 1, default: 2, show: (v) => !!v.zone && v.kind !== 'rest' && v.measure !== 'none' },
  { key: 'zone_min', label: (rules?.pace ? `Target range from (seconds ${perLabel(rules.pace_per_m)} for pace, watts for power)` : 'Target range from'), type: 'stepper', min: 0, max: 100000, step: 5, default: 0, hint: '0 = open', show: (v) => !!v.zone && v.kind !== 'rest' && v.measure !== 'none' },
  { key: 'zone_max', label: 'Target range to', type: 'stepper', min: 0, max: 100000, step: 5, default: 0, hint: '0 = open', show: (v) => !!v.zone && v.kind !== 'rest' && v.measure !== 'none' },
  { key: 'demo_url', label: 'Demonstration video link (https)', input: 'url', optional: true, show: (v) => v.kind !== 'rest' },
  { key: 'demo_title', label: 'Link title', optional: true, show: (v) => v.kind !== 'rest' && !!v.demo_url },
  { key: 'notes', label: 'Coaching notes', type: 'multiline', optional: true },
];

let seq = 0;
export const newBlockId = () => `b${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Form values to a block, dropping everything that is "not used". */
export function toBlock(v) {
  const rest = v.kind === 'rest';
  const o = { id: newBlockId(), kind: v.kind, label: String(v.label || KIND_LABEL[v.kind]).trim() };
  if (rest) { o.rest_sec = num(v.rest_sec); return o; }
  if (num(v.sets)) o.sets = num(v.sets);
  if (num(v.reps)) o.reps = num(v.reps);
  if (num(v.load_kg) && ['strength', 'work'].includes(v.kind)) o.load_kg = num(v.load_kg);
  if (v.measure === 'distance' && v.kind !== 'strength') o.work_m = num(v.work_m);
  if (v.measure === 'time' && v.kind !== 'strength') o.work_sec = num(v.work_sec);
  if (num(v.rest_sec) && v.kind !== 'warmup' && v.kind !== 'cooldown') o.rest_sec = num(v.rest_sec);
  if (v.zone && v.measure && v.measure !== 'none') {
    o.zone = { kind: v.zone, level: num(v.zone_level) || 2 };
    if (num(v.zone_min)) o.zone.min = num(v.zone_min);
    if (num(v.zone_max)) o.zone.max = num(v.zone_max);
  }
  if (v.demo_url) o.demo = { url: v.demo_url.trim(), ...(v.demo_title ? { title: v.demo_title } : {}) };
  if (v.notes) o.notes = v.notes;
  return o;
}

/** One group of fields per planned block for the athlete to record what they did. */
export function resultFields(blocks, rules, actuals) {
  const got = new Map((actuals ?? []).map((r) => [r.block_id, r]));
  const out = []; const initial = {};
  for (const b of blocks.filter((x) => x.kind !== 'rest')) {
    const r = got.get(b.id) ?? {};
    const k = (m) => `${b.id}__${m}`;
    out.push({ key: k('sec'), type: 'section', label: `${b.label} — plan: ${describeBlock(b, rules)}` });
    out.push({ key: k('completed'), label: 'Done as planned', type: 'switch', hint: 'Switch on if you did all of it; or enter what you actually did below.' });
    initial[k('completed')] = !!r.completed;
    const add = (m, f, v) => { out.push({ key: k(m), ...f }); initial[k(m)] = v ?? 0; };
    if (b.sets) add('sets_done', { label: 'Sets done', type: 'stepper', min: 0, max: 100, step: 1 }, r.sets_done);
    if (b.reps) add('reps_done', { label: 'Reps done per set', type: 'stepper', min: 0, max: 500, step: 1 }, r.reps_done);
    if (b.load_kg) add('load_kg', { label: 'Load used (kg)', type: 'stepper', min: 0, max: 1000, step: 2.5 }, r.load_kg);
    if (b.work_m) add('distance_m', { label: 'Total distance covered (metres)', type: 'stepper', min: 0, max: 200000, step: 50 }, r.distance_m);
    if (b.work_sec) add('duration_sec', { label: 'Total time spent (seconds)', type: 'stepper', min: 0, max: 86400, step: 30 }, r.duration_sec);
    if (b.zone?.kind === 'pace') add('avg_pace', { label: `Average pace (seconds ${perLabel(rules?.pace_per_m ?? 1000)})`, type: 'stepper', min: 0, max: 100000, step: 5, hint: '0 = not recorded' }, r.avg_pace);
    if (b.zone?.kind === 'power') add('avg_power_w', { label: 'Average power (watts)', type: 'stepper', min: 0, max: 3000, step: 5, hint: '0 = not recorded' }, r.avg_power_w);
  }
  return { fields: out, initial };
}

/** Form values to the results array, keeping only what was entered. */
export function toActuals(v, blocks) {
  return blocks.filter((b) => b.kind !== 'rest').map((b) => {
    const r = { block_id: b.id, completed: !!v[`${b.id}__completed`] };
    for (const m of ['sets_done', 'reps_done', 'load_kg', 'distance_m', 'duration_sec', 'avg_pace', 'avg_power_w']) {
      const x = Number(v[`${b.id}__${m}`] ?? 0);
      if (x > 0) r[m] = x;
    }
    return r;
  }).filter((r) => r.completed || Object.keys(r).length > 2);
}

const METRIC = { sets: 'sets', reps: 'reps', distance_m: 'distance', duration_sec: 'time', load_kg: 'load', pace: 'pace', power_w: 'power' };
const fmtMetric = (m, x, rules) => (x === null || x === undefined ? '—' : m === 'distance_m' ? fmtDist(x) : m === 'duration_sec' ? fmtTime(x) : m === 'pace' ? fmtPace(x, rules?.pace_per_m) : m === 'power_w' ? `${x} W` : m === 'load_kg' ? `${x} kg` : String(x));

/** Actual versus planned. Written out in words and numbers, never colour alone. */
export function Compliance({ data, rules }) {
  if (!data) return null;
  return (
    <View style={{ gap: 6, marginTop: 8 }} accessibilityLabel="Actual versus planned">
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <T weight="800" size={13}>Actual vs planned</T>
        {data.pct === null ? null : <Tag label={`${data.pct}% of plan`} color={data.pct >= 90 ? c.lime : c.violetSoft} />}
      </View>
      {data.blocks.filter((b) => b.recorded).map((b) => (
        <View key={b.block_id} style={{ gap: 1 }}>
          <T size={12} weight="700">{b.label}: {b.completed ? 'done' : 'partly done'} · {b.pct}%</T>
          {b.metrics.map((m) => (
            <T key={m.metric} size={12} color={c.mute}>
              {METRIC[m.metric]}: {Array.isArray(m.planned) ? `${m.planned.filter((x) => x !== null).map((x) => fmtMetric(m.metric, x, rules)).join(' – ') || 'open'} planned` : `${fmtMetric(m.metric, m.planned, rules)} planned`}, {m.actual === null || m.actual === undefined ? 'no figure entered' : `${fmtMetric(m.metric, m.actual, rules)} actual`}{m.in_zone === undefined ? '' : m.in_zone ? ' (inside the zone)' : ' (outside the zone)'}
            </T>
          ))}
        </View>
      ))}
      {data.recorded === 0 ? <T size={12} color={c.mute}>No detail was recorded for this session.</T> : null}
    </View>
  );
}


export const FOCUS = ['speed', 'endurance', 'strength', 'power', 'technical', 'tactical', 'recovery'].map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
export const PHASE_KINDS = [
  { value: 'preparation', label: 'Preparation' }, { value: 'pre_competition', label: 'Pre-competition' }, { value: 'competition', label: 'Competition' },
  { value: 'transition', label: 'Transition' }, { value: 'return_to_play', label: 'Return to play' },
];
const PHASE_LABEL = Object.fromEntries(PHASE_KINDS.map((k) => [k.value, k.label]));
export const phaseFields = [
  { key: 'kind', label: 'Phase', type: 'chips', options: PHASE_KINDS, default: 'preparation' },
  { key: 'label', label: 'Name (e.g. General preparation, Taper)' },
  { key: 'from', label: 'Dates', type: 'daterange', toKey: 'to' },
  { key: 'focus', label: 'What this phase is for', type: 'multiline', optional: true },
];

/** Periodisation: the phases of the season in order, with dates and purpose. */
export function Phases({ phases, onRemove }) {
  if (!phases?.length) return null;
  return (
    <View style={{ gap: 6 }}>
      {[...phases].sort((a, b) => a.from.localeCompare(b.from)).map((p, i) => (
        <View key={p.id} style={{ gap: 2 }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <T weight="700" size={13}>{p.label}</T><Tag label={PHASE_LABEL[p.kind]} />
            {onRemove ? <T size={12} color={c.red} weight="700" accessibilityRole="button" accessibilityLabel={`Remove phase ${p.label}`} onPress={() => onRemove(p.id)}>Remove</T> : null}
          </View>
          <T size={12} color={c.mute}>{p.from} to {p.to}{p.focus ? ` · ${p.focus}` : ''}</T>
        </View>
      ))}
    </View>
  );
}

const pctText = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v}%`);
/** Weekly microcycles: sessions, minutes, session-RPE load (effort × minutes) planned vs done, compliance and week-on-week change. */
export function WeeklyLoad({ weeks }) {
  if (!weeks?.length) return null;
  return (
    <View style={{ gap: 8 }} accessibilityLabel="Weekly training load">
      {weeks.map((w) => (
        <View key={w.week_start} style={{ borderLeftWidth: 3, borderLeftColor: w.large_planned_increase ? c.sun : c.line, paddingLeft: 10, gap: 2 }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <T weight="700" size={13}>Week of {w.week_start}</T>{w.phase ? <Tag label={w.phase} /> : null}
            {w.large_planned_increase ? <Tag label="Load up more than 30%" color={c.sunSoft} /> : null}
          </View>
          <T size={12} color={c.mute}>{w.completed === null ? `${w.sessions} sessions` : `${w.completed}/${w.sessions} sessions done`} · {w.planned_min} min planned{w.completed_min === null ? '' : `, ${w.completed_min} min done`}</T>
          <T size={12} color={c.mute}>Load (effort × minutes): {w.planned_load} planned{w.actual_load === null ? '' : `, ${w.actual_load} actual`} · change on last week {pctText(w.planned_load_change_pct)}{w.compliance_pct === null ? '' : ` · ${w.compliance_pct}% of planned work done`}</T>
        </View>
      ))}
      <T size={11} color={c.mute}>Load uses the session-RPE method (effort 1–10 × minutes). It is a planning aid, not medical advice.</T>
    </View>
  );
}

/** Save a base64 file returned by the API: a download on the web, the share sheet on a phone. */
export async function saveFile(out) {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const bytes = Uint8Array.from(atob(out.content), (ch) => ch.charCodeAt(0));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: out.content_type })); a.download = out.filename; a.click();
    return;
  }
  const { File, Paths } = await import('expo-file-system');
  const Sharing = await import('expo-sharing');
  const file = new File(Paths.cache, out.filename);
  file.create({ overwrite: true });
  file.write(Uint8Array.from(atob(out.content), (ch) => ch.charCodeAt(0)));
  if (!(await Sharing.isAvailableAsync())) throw new Error('This device cannot open PDF files from here. Open the plan on the web app.');
  await Sharing.shareAsync(file.uri, { mimeType: out.content_type, UTI: 'com.adobe.pdf', dialogTitle: out.filename });
}
