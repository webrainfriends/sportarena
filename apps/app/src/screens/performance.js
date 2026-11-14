import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Seg, Sheet, T } from '../ui';
import { c, day } from '../theme';
import { t } from '../i18n';

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

// ─── Provenance / explainability bottom-sheet ────────────────────────────────

function ProvenanceSheet({ sport, metric, onClose }) {
  const prov = useLoad(() => api.get(`/me/sport-analytics/${sport}/provenance`, metric ? { metric } : {}), [sport, metric]);
  const item = prov.data?.provenances?.[0];
  return (
    <Sheet visible onClose={onClose} title={t('spi.provenance.title')}>
      {prov.error ? <ErrorBox error={prov.error} onRetry={prov.reload} /> : !prov.data ? <Loading /> : !item ? <Empty emoji="ℹ️" title={t('spi.provenance.none')} /> : (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {item.direction ? <Chip label={`${item.direction === 'lower' ? '↓ lower' : '↑ higher'} is better`} color={c.lavender} /> : null}
            {item.unit ? <Chip label={item.unit} color={c.mist} /> : null}
            {item.governed === false ? <Chip label={t('spi.provenance.ungoverned')} color={c.mute} /> : null}
          </View>
          <View style={{ gap: 4 }}>
            <T size={11} weight="700" color={c.mute}>{t('spi.provenance.definition').toUpperCase()}</T>
            <T size={13}>{item.definition}</T>
          </View>
          {item.official_results ? (
            <View style={{ gap: 4 }}>
              <T size={11} weight="700" color={c.mint}>{t('spi.provenance.official').toUpperCase()}</T>
              <T size={13} color={c.mute}>{item.official_results.count} {t('spi.provenance.results')} · {item.official_results.from} → {item.official_results.to}</T>
            </View>
          ) : null}
          {item.self_reported_results ? (
            <View style={{ gap: 4 }}>
              <T size={11} weight="700" color={c.mute}>{t('spi.provenance.self').toUpperCase()}</T>
              <T size={13} color={c.mute}>{item.self_reported_results.count} {t('spi.provenance.results')} · {item.self_reported_results.from} → {item.self_reported_results.to}</T>
            </View>
          ) : null}
          {item.exclusions?.length ? (
            <View style={{ gap: 4 }}>
              <T size={11} weight="700" color={c.mute}>{t('spi.provenance.exclusions').toUpperCase()}</T>
              {item.exclusions.map((e, i) => <T key={i} size={12} color={c.mute}>• {e}</T>)}
            </View>
          ) : null}
          {item.limitations?.length ? (
            <View style={{ gap: 4 }}>
              <T size={11} weight="700" color={c.warning}>{t('spi.provenance.limitations').toUpperCase()}</T>
              {item.limitations.map((l, i) => <T key={i} size={12} color={c.mute}>• {l}</T>)}
            </View>
          ) : null}
          <T size={11} color={c.mute}>{t('spi.provenance.version')}: {item.calc_version}</T>
        </View>
      )}
    </Sheet>
  );
}

// ─── Single metric analytics card ────────────────────────────────────────────

function MetricCard({ metric, track, onInfo }) {
  const hasInsufficient = track?.insufficient;
  const pb = track?.personal_best;
  return (
    <Card pad={14} style={{ flex: 1, minWidth: 150 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <T size={11} weight="700" color={c.mute} style={{ letterSpacing: 0.5, flex: 1 }}>{nice(metric.metric_label ?? metric.metric).toUpperCase()}</T>
        <Pressable onPress={onInfo} accessibilityLabel={t('spi.provenance.open')} hitSlop={8} style={{ marginInlineStart: 6 }}>
          <T size={16} color={c.amethyst}>ⓘ</T>
        </Pressable>
      </View>
      {hasInsufficient ? (
        <T size={12} color={c.mute} style={{ marginTop: 6 }}>{t('spi.form.sample_insufficient', { n: track.results ?? 0, min: track.min_required })}</T>
      ) : (
        <>
          {pb ? <T weight="800" size={24} style={{ letterSpacing: -0.5, marginTop: 4, fontVariant: ['tabular-nums'] }}>{num(pb.value)}<T size={13} color={c.mute} weight="700">{metric.unit ? ` ${metric.unit}` : ''}</T></T> : null}
          {pb ? <T size={12} color={c.mute}>{t('spi.analytics.pb_on')} {day(pb.on + 'T12:00:00')}</T> : null}
          {track?.mean !== undefined ? <T size={12} color={c.mute} style={{ marginTop: 2 }}>{t('spi.analytics.average')}: {num(track.mean)}{metric.unit ? ` ${metric.unit}` : ''}</T> : null}
          {track?.sample_size ? <T size={11} color={c.mute} style={{ marginTop: 4 }}>n = {track.sample_size} {track.sample_unit ?? t('spi.analytics.results')}</T> : null}
        </>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
        <Chip label={metric.direction === 'lower' ? '↓ lower better' : '↑ higher better'} color={c.mist} small />
        {metric.governed !== false ? <Chip label={t('spi.analytics.governed')} color={c.lavender} small /> : null}
      </View>
    </Card>
  );
}

// ─── Analytics tab ───────────────────────────────────────────────────────────

function AnalyticsTab({ sport }) {
  const [evidence, setEvidence] = useState('approved_competition');
  const [provenance, setProvenance] = useState(null);
  const data = useLoad(() => api.get(`/me/sport-analytics/${sport}`, { evidence }), [sport, evidence]);

  const evidenceOpts = [
    { value: 'approved_competition', label: t('spi.evidence.official') },
    { value: 'self_reported', label: t('spi.evidence.practice') },
    { value: 'combined', label: t('spi.evidence.combined') },
  ];

  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;

  const d = data.data;

  // Sport-family-specific rendering
  const renderCricket = () => {
    const batting = d.batting, bowling = d.bowling;
    return (
      <View style={{ gap: 16 }}>
        {batting ? (
          <View style={{ gap: 8 }}>
            <T weight="700" size={15}>{t('spi.cricket.batting')}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {Object.entries(batting).map(([k, v]) => v && typeof v === 'object' && 'value' in v ? (
                <MetricCard key={k} metric={{ metric: k, metric_label: nice(k), unit: v.unit, direction: v.direction, governed: false }} track={{ personal_best: { value: v.value }, sample_size: v.sample_size, sample_unit: v.sample_unit, insufficient: v.insufficient }} onInfo={() => setProvenance(k)} />
              ) : null)}
            </View>
          </View>
        ) : null}
        {bowling ? (
          <View style={{ gap: 8 }}>
            <T weight="700" size={15}>{t('spi.cricket.bowling')}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {Object.entries(bowling).map(([k, v]) => v && typeof v === 'object' && 'value' in v ? (
                <MetricCard key={k} metric={{ metric: k, metric_label: nice(k), unit: v.unit, direction: v.direction, governed: false }} track={{ personal_best: { value: v.value }, sample_size: v.sample_size, sample_unit: v.sample_unit, insufficient: v.insufficient }} onInfo={() => setProvenance(k)} />
              ) : null)}
            </View>
          </View>
        ) : null}
      </View>
    );
  };

  const renderGenericTracks = () => {
    const tracks = d.tracks ?? {};
    return Object.entries(tracks).map(([evid, track]) => (
      <View key={evid} style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T weight="700" size={14} color={EVIDENCE[evid]?.[1] ?? c.mute}>{EVIDENCE[evid]?.[0] ?? evid}</T>
          {track.appearances !== undefined ? <T size={12} color={c.mute}>{track.appearances} {t('spi.analytics.appearances')}</T> : null}
          {track.verified_minutes ? <T size={12} color={c.mint}>{track.verified_minutes} {t('spi.analytics.verified_min')}</T> : null}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {Object.entries(track.metrics ?? {}).map(([k, v]) => (
            <MetricCard key={k} metric={{ metric: k, metric_label: nice(k), unit: v.unit, direction: v.direction, governed: false }} track={{ personal_best: { value: v.value }, sample_size: v.sample_size, insufficient: !v.value && v.insufficient }} onInfo={() => setProvenance(k)} />
          ))}
        </View>
      </View>
    ));
  };

  const renderAthletics = () => (d.events ?? []).map((ev) => (
    <View key={ev.metric} style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <T weight="700" size={14}>{nice(ev.metric_label ?? ev.metric)}</T>
        {ev.unit ? <T size={12} color={c.mute}>{ev.unit}</T> : null}
        {ev.direction ? <Chip label={ev.direction === 'lower' ? '↓ faster = better' : '↑ higher = better'} color={c.mist} small /> : null}
      </View>
      {Object.entries(ev.tracks ?? {}).map(([evid, tr]) => (
        <View key={evid} style={{ marginInlineStart: 8, gap: 4 }}>
          <T size={12} weight="700" color={EVIDENCE[evid]?.[1] ?? c.mute}>{EVIDENCE[evid]?.[0] ?? evid}</T>
          {tr.personal_best ? <T size={22} weight="800" style={{ fontVariant: ['tabular-nums'] }}>{num(tr.personal_best.value)}<T size={12} color={c.mute}> {ev.unit} PB</T></T> : null}
          {tr.progression ? <T size={12} color={tr.progression.improving ? c.mint : c.warning}>{tr.progression.improving ? '▲ Improving' : '▼ Declining'} over {tr.progression.over_attempts} results</T> : null}
          {tr.variance ? <T size={12} color={c.mute}>CV {num(tr.variance.cv_pct)}% consistency</T> : null}
          <Pressable onPress={() => setProvenance(ev.metric)} accessibilityLabel={t('spi.provenance.open')} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
            <T size={12} color={c.amethyst}>ⓘ {t('spi.provenance.open')}</T>
          </Pressable>
        </View>
      ))}
    </View>
  ));

  const renderGenericMetrics = () => (d.metrics ?? []).map((m) => (
    <MetricCard key={`${m.metric}:${m.evidence}`} metric={m} track={m} onInfo={() => setProvenance(m.metric)} />
  ));

  return (
    <View style={{ gap: 16 }}>
      <Seg options={evidenceOpts} value={evidence} onChange={setEvidence} />
      {d.limitations?.map((l, i) => <T key={i} size={12} color={c.warning}>⚠ {l}</T>)}
      {d.family === 'cricket' ? renderCricket() : d.family === 'athletics' ? renderAthletics() : d.tracks ? renderGenericTracks() : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>{renderGenericMetrics()}</View>
      )}
      {provenance ? <ProvenanceSheet sport={sport} metric={provenance} onClose={() => setProvenance(null)} /> : null}
    </View>
  );
}

// ─── Form tab ────────────────────────────────────────────────────────────────

function FormTab({ sport }) {
  const [evidence, setEvidence] = useState('approved_competition');
  const data = useLoad(() => api.get(`/me/sport-analytics/${sport}/form`, { evidence }), [sport, evidence]);
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  const windows = data.data.windows ?? [];
  return (
    <View style={{ gap: 16 }}>
      <Seg options={[{ value: 'approved_competition', label: t('spi.evidence.official') }, { value: 'self_reported', label: t('spi.evidence.practice') }]} value={evidence} onChange={setEvidence} />
      {windows.map((w) => (
        <Card key={String(w.window)} pad={14} style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <T weight="700" size={15}>{w.label}</T>
            {!w.sufficient ? <Chip label={t('spi.form.sample_low')} color={c.sunSoft} /> : null}
          </View>
          {w.from ? <T size={12} color={c.mute}>{t('spi.form.from')} {day(w.from + 'T12:00:00')}</T> : null}
          {w.sample_size !== null ? <T size={12} color={c.mute}>{w.sample_size} {t('spi.analytics.results')}</T> : null}
          {w.data?.limitations?.map((l, i) => <T key={i} size={11} color={c.warning}>⚠ {l}</T>)}
        </Card>
      ))}
      {!windows.length ? <Empty emoji="📉" title={t('spi.form.empty')} sub={t('spi.form.empty_sub')} /> : null}
    </View>
  );
}

// ─── Context tab (opponent/venue/competition/format/surface/position splits) ──

function ContextTab({ sport }) {
  const [dimension, setDimension] = useState(null);
  const [evidence, setEvidence] = useState('approved_competition');
  const data = useLoad(() => api.get(`/me/sport-analytics/${sport}/context`, { evidence, ...(dimension ? { dimension } : {}) }), [sport, evidence, dimension]);

  const dimOpts = [
    { value: null, label: t('spi.context.all') },
    { value: 'opponent', label: t('spi.context.opponent') },
    { value: 'venue', label: t('spi.context.venue') },
    { value: 'competition', label: t('spi.context.competition') },
    { value: 'format', label: t('spi.context.format') },
    { value: 'surface', label: t('spi.context.surface') },
    { value: 'position', label: t('spi.context.position') },
  ];

  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  const splits = data.data.splits ?? [];

  return (
    <View style={{ gap: 14 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
        {dimOpts.map((o) => (
          <Pressable key={String(o.value)} onPress={() => setDimension(o.value)} accessibilityRole="button"
            style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: dimension === o.value ? c.amethyst : c.mist }}>
            <T size={13} weight="600" color={dimension === o.value ? '#fff' : c.ink}>{o.label}</T>
          </Pressable>
        ))}
      </ScrollView>
      <Seg options={[{ value: 'approved_competition', label: t('spi.evidence.official') }, { value: 'self_reported', label: t('spi.evidence.practice') }]} value={evidence} onChange={setEvidence} />
      {!splits.length ? (
        <Empty emoji="🗂" title={t('spi.context.empty')} sub={t('spi.context.empty_sub')} />
      ) : splits.map((s) => (
        <Card key={`${s.dimension}:${s.dimension_value}`} pad={14} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View>
              <T size={11} weight="700" color={c.mute}>{t(`spi.context.${s.dimension}`, { defaultValue: s.dimension }).toUpperCase()}</T>
              <T weight="700" size={15} style={{ marginTop: 2 }}>{s.dimension_label}</T>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              {s.win_rate !== null ? <T weight="800" size={20} color={s.win_rate >= 50 ? c.mint : c.warning} style={{ fontVariant: ['tabular-nums'] }}>{num(s.win_rate)}%</T> : null}
              {s.win_rate !== null ? <T size={11} color={c.mute}>{t('spi.context.win_rate')}</T> : null}
            </View>
          </View>
          <T size={12} color={c.mute}>n = {s.sample_size} · {s.decided ?? s.sample_size} {t('spi.context.decided')}</T>
          <Chip label={EVIDENCE[s.evidence]?.[0] ?? s.evidence} color={EVIDENCE[s.evidence]?.[1] ?? c.mute} small />
        </Card>
      ))}
      {data.data.note ? <T size={11} color={c.mute}>{data.data.note}</T> : null}
    </View>
  );
}

// ─── Insights tab (AI-cited narratives) ──────────────────────────────────────

function InsightsTab({ sport }) {
  const [evidence, setEvidence] = useState('approved_competition');
  // Insights come from the existing coaching-ai capability when the athlete is their own coach context.
  // Athletes see the sport-native analytics summary from get_sport_analytics directly (no AI for self-view).
  const data = useLoad(() => api.get(`/me/sport-analytics/${sport}`, { evidence }), [sport, evidence]);
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;
  const d = data.data;
  const lims = d.limitations ?? [];
  return (
    <View style={{ gap: 14 }}>
      <Seg options={[{ value: 'approved_competition', label: t('spi.evidence.official') }, { value: 'self_reported', label: t('spi.evidence.practice') }, { value: 'combined', label: t('spi.evidence.combined') }]} value={evidence} onChange={setEvidence} />
      {lims.map((l, i) => <T key={i} size={12} color={c.warning}>⚠ {l}</T>)}
      <Card pad={14} style={{ gap: 8 }}>
        <T weight="700" size={15}>{t('spi.insights.adapter_family')}: {d.sport_name}</T>
        <T size={12} color={c.mute}>{t('spi.insights.adapter_version')}: {d.adapter_version ?? d.calc_version}</T>
        <T size={12} color={c.mute}>{t('spi.insights.evidence_track')}: {EVIDENCE[evidence]?.[0] ?? evidence}</T>
        <T size={12} color={c.mute}>{t('spi.insights.draft_disclaimer')}</T>
      </Card>
      <Empty emoji="💡" title={t('spi.insights.coach_view')} sub={t('spi.insights.coach_view_sub')} />
    </View>
  );
}

// ─── Full sport performance dashboard (Analytics + Form + Context + Insights) ─

/** Main sport analytics screen. Called with props.sport = sport slug. Extends existing RecordsSection. */
export function SportAnalyticsScreen({ sport }) {
  const [tab, setTab] = useState('analytics');
  const tabs = [
    { value: 'analytics', label: t('spi.tab.analytics') },
    { value: 'form', label: t('spi.tab.form') },
    { value: 'context', label: t('spi.tab.context') },
    { value: 'insights', label: t('spi.tab.insights') },
  ];
  return (
    <View style={{ flex: 1, gap: 0 }}>
      <Seg options={tabs} value={tab} onChange={setTab} style={{ marginHorizontal: 16, marginTop: 8 }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {tab === 'analytics' ? <AnalyticsTab sport={sport} /> : null}
        {tab === 'form' ? <FormTab sport={sport} /> : null}
        {tab === 'context' ? <ContextTab sport={sport} /> : null}
        {tab === 'insights' ? <InsightsTab sport={sport} /> : null}
        <RecordsSection sport={sport} />
      </ScrollView>
    </View>
  );
}
