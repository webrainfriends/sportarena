import React, { useState } from 'react';
import { View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, ErrorBox, Loading, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { dateTimeIn, todayIn } from '../vtime';

const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
const pct = (n) => `${Math.round(n * 100)}%`;
const BAND_COL = { ready: c.mint, moderate: c.sun, rest: c.red };
const SOURCE = { daily_log: ['Daily log', c.limeSoft], body_map: ['Body map', c.sunSoft], missing: ['Not logged', c.violetSoft] };
const CONF = { none: ['No score yet', c.violetSoft], low: ['Low confidence', c.sunSoft], moderate: ['Moderate confidence', c.cyanSoft], good: ['Good coverage', c.limeSoft] };
const plain = (e) => (e?.details?.code === 'stale_version' ? 'These settings changed elsewhere. They have been reloaded; please check and try again.' : e?.message ?? 'Something went wrong');
const rawText = (r) => {
  if (!r) return null;
  if ('sleep_hours' in r) return [r.sleep_hours != null ? `${r.sleep_hours} h` : null, r.sleep_quality != null ? `quality ${r.sleep_quality}/5` : null].filter(Boolean).join(' · ');
  if ('soreness' in r) return `soreness ${r.soreness}/10`;
  if ('worst_open_body_map_severity' in r) return `worst open entry ${r.worst_open_body_map_severity}/10`;
  return `mood ${r.mood}/5`;
};

function Section({ title, children }) {
  return <View style={{ gap: 6, marginTop: 16 }}><T size={11} weight="700" color={c.mute}>{title}</T>{children}</View>;
}

function InputRow({ i }) {
  const [srcLabel, srcColor] = SOURCE[i.source];
  const detail = !i.logged ? null : !i.shown ? 'Counted; value not shared with you' : rawText(i.raw);
  return (
    <View accessible accessibilityLabel={`${i.label}: ${i.logged ? `${detail ?? ''}, adds ${i.points ?? 'an undisclosed number of'} points` : 'not logged'}, weight ${pct(i.weight)}`} style={{ borderWidth: 1.5, borderColor: c.line, borderRadius: 12, padding: 10, gap: 4, opacity: i.logged ? 1 : 0.75 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <T weight="800" style={{ flex: 1, minWidth: 80 }}>{i.label}</T>
        <Tag label={srcLabel} color={srcColor} />
      </View>
      <T size={12} color={c.mute}>Weight {pct(i.weight)}{i.logged && i.effective_weight !== i.weight ? ` · counts as ${pct(i.effective_weight)} of today's score` : ''}</T>
      {i.logged ? <T size={13}>{detail}{i.points != null ? <T size={13} weight="800"> · +{i.points} points</T> : null}</T> : null}
    </View>
  );
}

/** Day-by-day scores. A day with no log is an empty stub, never a made-up bar. */
function Trend({ days }) {
  const W = 280, H = 64, n = days.length, bw = W / n;
  const scored = days.filter((d) => d.score !== null).length;
  return (
    <View>
      <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" accessibilityLabel={`Readiness for the last ${n} days. ${scored} days have a score. ${days.map((d) => `${d.date}: ${d.score ?? 'no log'}`).join('; ')}`}>
        {days.map((d, k) => {
          const h = d.score === null ? 2 : Math.max(3, (d.score / 100) * (H - 4));
          return <Rect key={d.date} x={k * bw + 1} y={H - h} width={Math.max(2, bw - 2)} height={h} rx={2} fill={d.score === null ? c.line : BAND_COL[d.band] ?? c.mute} />;
        })}
      </Svg>
      <T size={11} color={c.mute}>Last {n} days · {scored} with a score · grey = nothing logged</T>
    </View>
  );
}

const SETTING_ROWS = (s) => [
  ['Ready from', `${s.bands.ready_min}+`], ['Take it steady from', `${s.bands.moderate_min}+`],
  ['Workload low below', s.workload.low_below], ['Workload optimal up to', s.workload.optimal_max], ['Workload caution up to', s.workload.caution_max],
  ['Points off in caution', s.workload.caution_penalty], ['Points off when high', s.workload.high_penalty],
];

/**
 * How a readiness score is made, in one place for the athlete (mode "self") and for a coach or clinician reading a share (mode "staff"):
 * inputs and weights, coverage, what is missing, the workload basis, the day-by-day trend, the settings in force and who set them, and the
 * limits. Staff see raw values only for fields the athlete shared. Nothing here is a diagnosis or clearance.
 */
export function ReadinessExplainer({ mode = 'self', shareId, athleteName, onChanged, onLog }) {
  const { toast } = useSession();
  const today = todayIn(tz);
  const staff = mode === 'staff';
  const ex = useLoad(() => (staff ? api.get(`/wellness-shared/${shareId}/readiness`, { date: today }) : api.get('/me/readiness/explanation', { date: today })), [mode, shareId]);
  const hist = useLoad(() => (staff ? Promise.resolve(null) : api.get('/me/readiness/history')), [mode, shareId]);
  const conf = useLoad(() => (staff ? Promise.resolve(null) : api.get('/me/readiness/config')), [mode, shareId]);
  const [open, setOpen] = useState(false), [edit, setEdit] = useState(false), [reset, setReset] = useState(false), [busy, setBusy] = useState(false);
  const reloadAll = () => Promise.all([ex.reload(), hist.reload(), conf.reload()]);

  if (ex.error) return <ErrorBox error={ex.error} onRetry={ex.reload} />;
  if (!ex.data) return <Card><Loading /></Card>;
  const d = ex.data, st = d.settings;
  const days = staff ? d.history : hist.data?.days;
  const [confLabel, confColor] = CONF[d.confidence];
  const custom = st.source === 'custom';
  const doReset = async () => {
    setBusy(true);
    try { const r = await api.post('/me/readiness/config/reset', { version: st.version }); toast(r.changed ? 'Back on the standard settings' : 'Already on the standard settings'); setReset(false); await reloadAll(); await onChanged?.(); }
    catch (e) { toast(plain(e)); if (e?.details?.code === 'stale_version') { setReset(false); await reloadAll(); } } finally { setBusy(false); }
  };
  const w = st.weights, k = st.workload;
  const editFields = [
    { key: 'sleep', label: 'Sleep', type: 'stepper', min: 10, max: 70, step: 5, suffix: '%' },
    { key: 'soreness', label: 'Soreness', type: 'stepper', min: 10, max: 70, step: 5, suffix: '%' },
    { key: 'mood', label: 'Mood', type: 'stepper', min: 10, max: 70, step: 5, suffix: '%', hint: 'The three must add up to 100%.' },
    { key: 'ready_min', label: '“Ready” from score', type: 'stepper', min: 50, max: 90, step: 5 },
    { key: 'moderate_min', label: '“Take it steady” from score', type: 'stepper', min: 20, max: 60, step: 5 },
    { key: 'low_below', label: 'Workload “low” below', type: 'stepper', min: 0.5, max: 1, step: 0.05 },
    { key: 'optimal_max', label: 'Workload “optimal” up to', type: 'stepper', min: 1.1, max: 1.6, step: 0.05 },
    { key: 'caution_max', label: 'Workload “caution” up to', type: 'stepper', min: 1.3, max: 2, step: 0.05 },
    { key: 'caution_penalty', label: 'Points off in caution', type: 'stepper', min: 0, max: 15, step: 1 },
    { key: 'high_penalty', label: 'Points off when high', type: 'stepper', min: 0, max: 25, step: 1 },
    { key: 'min_span_days', label: 'Days of sessions before the ratio counts', type: 'stepper', min: 14, max: 35, step: 1, suffix: ' d' },
    { key: 'reason', label: `Why these settings suit ${athleteName ?? 'this athlete'}`, type: 'multiline', hint: 'Shown to the athlete (and a guardian). At least 10 characters; stored encrypted.' },
  ];
  const editInitial = { sleep: Math.round(w.sleep * 100), soreness: Math.round(w.soreness * 100), mood: Math.round(w.mood * 100), ready_min: st.bands.ready_min, moderate_min: st.bands.moderate_min, low_below: k.low_below, optimal_max: k.optimal_max, caution_max: k.caution_max, caution_penalty: k.caution_penalty, high_penalty: k.high_penalty, min_span_days: k.min_span_days };

  return (
    <Card pad={16}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <T weight="800" size={16} style={{ flex: 1, minWidth: 160 }}>How this score is built</T>
        <Tag label={confLabel} color={confColor} />
      </View>
      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <Tag label="Heuristic · not a medical tool" color={c.sunSoft} />
        <Tag label={`Formula v${d.formula.version}`} color={c.violetSoft} />
        <Tag label={custom ? `Adjusted · settings v${st.version}` : st.status === 'paused' ? 'Standard (adjustment paused)' : 'Standard settings'} color={custom ? c.pinkSoft : c.violetSoft} />
      </View>

      <Section title="COVERAGE">
        <View accessible accessibilityLabel={`${d.coverage.inputs_logged} of ${d.coverage.inputs_total} inputs logged, ${pct(d.coverage.weight_covered)} of the formula`}>
          <View style={{ height: 10, borderRadius: 5, backgroundColor: c.line, overflow: 'hidden' }}><View style={{ width: pct(d.coverage.weight_covered), height: 10, backgroundColor: c.mint }} /></View>
        </View>
        <T size={13}>{d.coverage.inputs_logged} of {d.coverage.inputs_total} inputs logged today · {pct(d.coverage.weight_covered)} of the formula · logged on {d.coverage.days_logged_7} of the last 7 days</T>
        {d.score === null ? <T size={13} color={c.mute}>No score yet. {staff ? 'The athlete has not logged these today.' : 'Nothing is estimated for you: log something and it appears.'}</T> : d.coverage.level === 'partial' ? <T size={13} color={c.mute}>The score is worked out from the inputs you logged, re-weighted to add up to 100%. It is less reliable than a full log.</T> : null}
      </Section>

      <Section title={`WHAT WENT IN${d.score !== null ? ` · SCORE ${d.score}` : ''}`}>
        <View style={{ gap: 8 }}>{d.inputs.map((i) => <InputRow key={i.key} i={i} />)}</View>
        {d.base_score !== null && d.workload_adjustment !== null ? <T size={13} color={c.mute}>Base {d.base_score}{d.workload_adjustment ? ` ${d.workload_adjustment} for workload` : ''} = <T size={13} weight="800">{d.score}</T></T> : null}
      </Section>

      {d.missing.length ? (
        <Section title="MISSING">
          {d.missing.map((m) => <T key={m.key} size={13}>• <T size={13} weight="800">{m.label}</T> is not logged. {staff ? '' : m.how_to_fix}</T>)}
          {!staff && onLog ? <Btn small title="Log it now" onPress={onLog} style={{ alignSelf: 'flex-start', marginTop: 4 }} accessibilityLabel="Open the quick log" /> : null}
        </Section>
      ) : null}

      <Section title="WORKLOAD">
        {d.workload.hidden ? <T size={13} color={c.mute}>Workload was not shared with you, so only the score is shown.</T> : (
          <View style={{ gap: 4 }}>
            <T size={13}><T size={13} weight="800">{d.workload.ratio ?? '–'}</T> acute : chronic · {String(d.workload.status).replace('_', ' ')}{d.workload.sessions_28d ? ` · ${d.workload.sessions_28d} sessions in 28 days` : ''}</T>
            <T size={13} color={c.mute}>{d.workload.counts_toward_score ? `Took ${-d.workload.adjustment_points} points off today's score.` : d.workload.reason ?? 'In range: no points taken off.'}</T>
            {d.workload.trusted === false && d.workload.status !== 'no_data' ? (
              <View accessible accessibilityLabel={`${d.workload.span_days} of ${d.workload.days_needed} days of sessions`} style={{ height: 8, borderRadius: 4, backgroundColor: c.line, overflow: 'hidden' }}><View style={{ width: `${Math.min(100, (d.workload.span_days / d.workload.days_needed) * 100)}%`, height: 8, backgroundColor: c.sun }} /></View>
            ) : null}
          </View>
        )}
      </Section>

      <Btn small title={open ? 'Hide history, settings and limits' : 'Show history, settings and limits'} color={c.paper} ink={c.ink} onPress={() => setOpen(!open)} style={{ alignSelf: 'flex-start', marginTop: 14 }} accessibilityLabel={open ? 'Hide history, settings and limits' : 'Show history, settings and limits'} />

      {open ? (
        <View>
          {days ? <Section title="HISTORY"><Trend days={days} />{!staff ? <T size={11} color={c.mute}>Recomputed from your logs with the settings in force now.</T> : null}</Section> : hist.error ? <ErrorBox error={hist.error} onRetry={hist.reload} /> : null}

          <Section title="SETTINGS IN FORCE">
            <T size={13}>{custom ? <>Adjusted by <T size={13} weight="800">{st.set_by?.name}</T> ({st.set_by?.kind === 'provider' ? 'clinician' : 'coach'}) on {dateTimeIn(st.set_at, tz)}.</> : st.status === 'paused' ? `${st.set_by?.name}'s adjustment is paused: ${st.paused_reason} The standard settings apply.` : 'The standard weights and thresholds for everyone.'}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {Object.entries(w).map(([key, v]) => <Tag key={key} label={`${key} ${pct(v)}`} color={c.pinkSoft} />)}
            </View>
            {SETTING_ROWS(st).map(([label, v]) => <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T size={13} color={c.mute}>{label}</T><T size={13} weight="700">{v}</T></View>)}
            {custom && !staff ? <T size={12} color={c.mute}>These apply only while sharing with {st.set_by?.name} stays on. You can go back to the standard at any time.</T> : null}
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              {staff ? <Btn small title="Adjust settings" onPress={() => setEdit(true)} accessibilityLabel={`Adjust readiness settings for ${athleteName}`} /> : null}
              {!staff && custom ? <Btn small title="Reset to standard" color={c.paper} ink={c.red} onPress={() => setReset(true)} accessibilityLabel="Reset readiness settings to the standard" /> : null}
            </View>
          </Section>

          {!staff && conf.data?.versions?.length ? (
            <Section title="SETTINGS HISTORY">
              {conf.data.versions.map((v) => (
                <View key={v.version} style={{ borderWidth: 1.5, borderColor: c.line, borderRadius: 12, padding: 10, gap: 2 }}>
                  <T size={13} weight="800">v{v.version} · {v.source === 'reset' ? 'Reset to standard' : 'Adjusted'} by {v.set_by_name}</T>
                  <T size={12} color={c.mute}>{dateTimeIn(v.created_at, tz)}{v.reason ? ` · “${v.reason}”` : ''}</T>
                </View>
              ))}
            </Section>
          ) : conf.error ? <ErrorBox error={conf.error} onRetry={conf.reload} /> : null}

          <Section title="WHAT STAYS FIXED">{d.fixed_rules.map((r) => <T key={r} size={13}>• {r}</T>)}</Section>
          <Section title="LIMITS">{d.limitations.map((r) => <T key={r} size={13}>• {r}</T>)}</Section>
        </View>
      ) : null}

      {staff ? (
        <FormSheet visible={edit} onClose={() => setEdit(false)} title="Adjust readiness settings" submitLabel="Save settings" fields={editFields} initial={editInitial}
          notice={`${athleteName ?? 'The athlete'} is told, can see your reason, and can reset to the standard at any time. Your change applies only while they keep sharing with you.`}
          onSubmit={async (v) => {
            if (v.sleep + v.soreness + v.mood !== 100) throw new Error(`The three weights add up to ${v.sleep + v.soreness + v.mood}%. They must make 100%.`);
            const r2 = (n) => Math.round(n * 100) / 100;
            try {
              const out = await api.post(`/wellness-shared/${shareId}/readiness-config`, {
                version: st.version, reason: v.reason,
                weights: { sleep: v.sleep / 100, soreness: v.soreness / 100, mood: v.mood / 100 }, bands: { ready_min: v.ready_min, moderate_min: v.moderate_min },
                workload: { low_below: r2(v.low_below), optimal_max: r2(v.optimal_max), caution_max: r2(v.caution_max), caution_penalty: v.caution_penalty, high_penalty: v.high_penalty, min_span_days: v.min_span_days },
              });
              await ex.reload(); await onChanged?.();
              return out.changed ? 'Saved. The athlete has been told.' : 'Already saved.';
            } catch (e) { if (e?.details?.code === 'stale_version') await ex.reload(); throw new Error(plain(e)); }
          }} />
      ) : (
        <Sheet visible={reset} onClose={() => setReset(false)} title="Reset to the standard?">
          <T size={14}>Readiness goes back to the standard weights and thresholds. The adjustment stays in your settings history.</T>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <Btn title="Reset to standard" color={c.red} onPress={doReset} loading={busy} />
            <Btn title="Keep adjusted" color={c.paper} ink={c.ink} onPress={() => setReset(false)} />
          </View>
        </Sheet>
      )}
    </Card>
  );
}
