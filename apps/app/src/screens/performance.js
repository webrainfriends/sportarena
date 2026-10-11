import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Btn, Card, Empty, ErrorBox, Loading, Seg, Sheet, T } from '../ui';
import { c, day } from '../theme';

const nice = (s) => String(s).replace(/_/g, ' ');
const num = (v) => (v === null || v === undefined ? '–' : Number.isInteger(+v) ? String(+v) : String(Math.round(+v * 100) / 100));
const unitOf = (u) => (u === 's' ? ' s' : u === 'm' ? ' m' : '');
const EVIDENCE = { approved_competition: ['Official', c.mint], self_reported: ['Practice', c.mute], imported: ['Imported', c.cyan] };

/** Trend of one metric. Better is always up: for times (lower wins) the axis is flipped so improving looks like climbing. Gold dots set a new best. */
export function TrendChart({ points, direction }) {
  const [w, setW] = useState(300);
  const H = 150, pad = 14;
  if (!points.length) return <Empty emoji="📈" title="No results to chart yet" />;
  const vals = points.map((p) => p.value);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const t0 = Date.parse(points[0].on), t1 = Date.parse(points.at(-1).on), tspan = t1 - t0 || 1;
  const x = (p, i) => (points.length === 1 ? w / 2 : pad + ((points.length > 1 && tspan > 1 ? (Date.parse(p.on) - t0) / tspan : i / (points.length - 1)) * (w - pad * 2)));
  const y = (v) => pad + (direction === 'lower' ? (v - lo) / span : (hi - v) / span) * (H - pad * 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p, i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  return (
    <View onLayout={(e) => setW(Math.max(200, e.nativeEvent.layout.width))}>
      <Svg width={w} height={H} accessibilityLabel={`Trend of ${points.length} results from ${num(points[0].value)} to ${num(points.at(-1).value)}`}>
        <Line x1={pad} x2={w - pad} y1={H - pad} y2={H - pad} stroke={c.line} strokeWidth={1} />
        <Path d={d} stroke={c.pink} strokeWidth={2.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => <Circle key={p.id} cx={x(p, i)} cy={y(p.value)} r={p.is_pr ? 6 : 4} fill={p.is_pr ? c.sun : c.paper} stroke={p.is_pr ? c.sun : c.pink} strokeWidth={2} />)}
      </Svg>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <T size={11} color={c.mute}>{day(points[0].on + 'T12:00:00')}</T>
        <T size={11} color={c.mute}>{direction === 'lower' ? 'Higher on the chart = faster' : 'Higher on the chart = more'}</T>
        <T size={11} color={c.mute}>{day(points.at(-1).on + 'T12:00:00')}</T>
      </View>
    </View>
  );
}

function TrendSheet({ rec, onClose }) {
  const t = useLoad(() => api.get('/me/trends', { sport: rec.sport, metric: rec.metric, evidence: rec.evidence }), [rec.sport, rec.metric, rec.evidence]);
  const u = unitOf(rec.unit);
  return (
    <Sheet visible onClose={onClose} title={nice(rec.metric)}>
      <View style={{ gap: 12 }}>
        <T size={13} color={c.mute}>{EVIDENCE[rec.evidence]?.[0]} results · best {num(rec.value)}{u} on {day(rec.achieved_on + 'T12:00:00')}</T>
        {t.error ? <ErrorBox error={t.error} onRetry={t.reload} /> : !t.data ? <Loading /> : <TrendChart points={t.data.points} direction={t.data.direction} />}
        {t.data?.points.length ? <T size={12} color={c.mute}>Gold dots mark a new personal best. {t.data.points.length} result{t.data.points.length === 1 ? '' : 's'}.</T> : null}
      </View>
    </Sheet>
  );
}

/** Personal records for one sport (or all): the best per metric with date, how much it improved and a NEW badge for the last 30 days. */
export function RecordsSection({ sport }) {
  const { push } = useNav();
  const recs = useLoad(() => api.get('/me/records', sport ? { sport } : {}), [sport]);
  const [open, setOpen] = useState(null);
  const [evidence, setEvidence] = useState('all');
  if (recs.error) return <ErrorBox error={recs.error} onRetry={recs.reload} />;
  if (!recs.data) return <Loading />;
  const kinds = [...new Set(recs.data.map((r) => r.evidence))];
  const rows = recs.data.filter((r) => evidence === 'all' || r.evidence === evidence);
  return (
    <View style={{ gap: 10 }}>
      {kinds.length > 1 ? <Seg options={[{ value: 'all', label: 'All' }, ...kinds.map((k) => ({ value: k, label: EVIDENCE[k]?.[0] ?? k }))]} value={evidence} onChange={setEvidence} /> : null}
      {!rows.length ? (
        <Empty emoji="🏅" title="No records yet" sub="Your best times, distances and counts show up here as soon as you log practice or an official result is approved." />
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {rows.map((r) => {
            const better = r.direction === 'lower' ? 'faster' : 'more';
            return (
              <Pressable key={`${r.sport}${r.metric}${r.evidence}`} onPress={() => setOpen(r)} accessibilityRole="button" accessibilityLabel={`${nice(r.metric)} record ${num(r.value)}${unitOf(r.unit)}. Open trend`} style={{ flexBasis: '47%', flexGrow: 1, minWidth: 140 }}>
                <Card pad={14}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <T size={11} weight="700" color={c.mute} style={{ letterSpacing: 0.5 }}>{nice(r.metric).toUpperCase()}</T>
                    {r.recent ? <View style={{ backgroundColor: c.sunSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}><T size={10} weight="800" color="#92400E">NEW PR</T></View> : null}
                  </View>
                  <T weight="800" size={26} style={{ letterSpacing: -0.6, marginTop: 4, fontVariant: ['tabular-nums'] }}>{num(r.value)}<T size={14} color={c.mute} weight="700">{unitOf(r.unit)}</T></T>
                  <T size={12} color={c.mute}>{day(r.achieved_on + 'T12:00:00')} · {r.entries} result{r.entries === 1 ? '' : 's'}</T>
                  {r.improved_by !== null ? <T size={12} weight="700" color={c.mint} style={{ marginTop: 4 }}>▲ {num(r.improved_by)}{unitOf(r.unit)} {better} than before</T> : <T size={12} color={c.mute} style={{ marginTop: 4 }}>First result</T>}
                  <T size={11} weight="700" color={EVIDENCE[r.evidence]?.[1] ?? c.mute} style={{ marginTop: 6 }}>{r.evidence === 'approved_competition' ? '✓ ' : ''}{r.evidence_label}</T>
                </Card>
              </Pressable>
            );
          })}
        </View>
      )}
      <Btn small title="All my results & log a practice result" color={c.paper} ink={c.ink} onPress={() => push('Leaderboard')} style={{ alignSelf: 'flex-start' }} />
      {open ? <TrendSheet rec={open} onClose={() => setOpen(null)} /> : null}
    </View>
  );
}
