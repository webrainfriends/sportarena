// Platform Competitive Benchmarks — platform admin only.
// The 10 KPIs that measure GotMyGame's health vs Playo, GotSport, Hudle, TeamSnap, RAMP, PlayAtomic, play.book.
// Entry point: More wheel → Workspaces → "Platform benchmarks" (platform_admin role only).
import React, { useMemo, useState } from 'react';
import { ScrollView, TouchableOpacity, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { useNav } from '../nav';
import { Btn, Card, Empty, ErrorBox, Field, Loading, Row, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { DateRangeField } from '../pickers';
import { c } from '../theme';
import { t } from '../i18n';

const PRESETS = [
  { value: 'last_7', label: t('bench.preset.7d') },
  { value: 'last_30', label: t('bench.preset.30d') },
  { value: 'last_90', label: t('bench.preset.90d') },
  { value: 'year_to_date', label: t('bench.preset.ytd') },
  { value: 'custom', label: t('bench.preset.custom') },
];

const COMPETITORS = ['playo', 'gotsport', 'hudle', 'teamsnap', 'ramp', 'playatomic', 'play_book'];
const COMP_LABEL = { playo: 'Playo', gotsport: 'GotSport', hudle: 'Hudle', teamsnap: 'TeamSnap', ramp: 'RAMP', playatomic: 'PlayAtomic', play_book: 'play.book' };

const STATUS_COLOR = {
  exceeds: c.limeSoft, on_track: c.cyanSoft, at_risk: c.sunSoft, critical: c.orangeSoft, no_data: c.line,
};
const STATUS_INK = {
  exceeds: c.lime, on_track: c.cyan, at_risk: c.sun, critical: c.orange, no_data: c.mute,
};
const STATUS_LABEL = {
  exceeds: 'bench.status.exceeds', on_track: 'bench.status.on_track',
  at_risk: 'bench.status.at_risk', critical: 'bench.status.critical', no_data: 'bench.status.no_data',
};
const GRADE_COLOR = { S: c.lime, A: '#4C9A7A', B: c.cyan, C: c.sun, D: c.orange, F: c.red };
const LOWER_BETTER = new Set(['venue_onboard_days', 'tournament_publish_time', 'support_resolution_hrs']);

function fmtVal(v, unit) {
  if (v == null) return '—';
  if (unit === 'percent') return `${v}%`;
  if (unit === 'hours') return v < 24 ? `${v}h` : `${(v / 24).toFixed(1)}d`;
  if (unit === 'days') return `${v}d`;
  if (unit === 'minutes') return `${v}m`;
  return String(v);
}

function fmtDelta(delta, unit, kpiKey) {
  if (delta == null) return null;
  const good = LOWER_BETTER.has(kpiKey) ? delta < 0 : delta > 0;
  const arrow = delta > 0 ? '▲' : '▼';
  const abs = Math.abs(delta);
  return { label: unit === 'percent' ? `${arrow} ${abs}pp` : `${arrow} ${fmtVal(abs, unit)}`, color: good ? c.lime : c.orange };
}

function platformScore(kpis) {
  if (!kpis?.length) return 0;
  const W = { exceeds: 100, on_track: 70, at_risk: 40, critical: 10, no_data: 0 };
  return Math.round(kpis.reduce((s, k) => s + (W[k.status] ?? 0), 0) / kpis.length);
}

function gradeOf(score) {
  if (score >= 90) return 'S';
  if (score >= 75) return 'A';
  if (score >= 55) return 'B';
  if (score >= 35) return 'C';
  if (score >= 15) return 'D';
  return 'F';
}

// ─── Sparkline (react-native-svg bars) ─────────────────────────────────────
function Sparkline({ trend = [], kpiKey, width = 120, height = 28 }) {
  const vals = trend.map((p) => p.value).filter((v) => v != null);
  if (!vals.length) return <View style={{ width, height }} />;
  const lowerBetter = LOWER_BETTER.has(kpiKey);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const n = trend.length;
  const barW = Math.max(1, Math.floor((width - n + 1) / n));
  return (
    <Svg width={width} height={height}>
      {trend.map((p, i) => {
        if (p.value == null) return null;
        const ratio = (p.value - min) / range;
        const barH = Math.round((lowerBetter ? (1 - ratio) : ratio) * (height - 4)) + 2;
        const fill = p.status === 'exceeds' ? '#4C9A7A'
          : p.status === 'on_track' ? c.cyan
          : p.status === 'at_risk' ? c.sun
          : p.status === 'critical' ? c.orange
          : c.mute;
        return (
          <Rect key={i} x={i * (barW + 1)} y={height - barH} width={barW} height={barH} rx={2} fill={fill} opacity={0.9} />
        );
      })}
    </Svg>
  );
}

// ─── Health Strip ───────────────────────────────────────────────────────────
function HealthStrip({ kpis, loading }) {
  const score = useMemo(() => platformScore(kpis), [kpis]);
  const grade = gradeOf(score);
  const exceeds = kpis.filter((k) => k.status === 'exceeds').length;
  const onTrack = kpis.filter((k) => k.status === 'on_track').length;
  const atRisk = kpis.filter((k) => k.status === 'at_risk' || k.status === 'critical').length;
  const gc = GRADE_COLOR[grade] ?? c.pink;
  return (
    <View style={{ backgroundColor: c.violet, borderRadius: 18, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <View style={{ alignItems: 'center', width: 68 }}>
        <View style={{ width: 60, height: 60, borderRadius: 30, borderWidth: 4, borderColor: gc, alignItems: 'center', justifyContent: 'center' }}>
          <T size={22} weight="800" color="#fff">{loading ? '…' : score}</T>
        </View>
        <View style={{ marginTop: 5, backgroundColor: gc, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
          <T size={11} weight="800" color={c.ink}>{grade}</T>
        </View>
      </View>
      <View style={{ flex: 1, gap: 7 }}>
        <T size={13} weight="800" color="#fff">{t('bench.score_label')}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {exceeds > 0 && (
            <View style={{ backgroundColor: c.limeSoft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
              <T size={11} weight="700" color={c.lime}>{exceeds} {t('bench.status.exceeds')}</T>
            </View>
          )}
          {onTrack > 0 && (
            <View style={{ backgroundColor: c.cyanSoft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
              <T size={11} weight="700" color={c.cyan}>{onTrack} {t('bench.status.on_track')}</T>
            </View>
          )}
          {atRisk > 0 && (
            <View style={{ backgroundColor: c.sunSoft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
              <T size={11} weight="700" color={c.sun}>{atRisk} {t('bench.status.at_risk')}</T>
            </View>
          )}
        </View>
        <T size={10} color={c.cyanSoft}>{t('bench.competitive_note')}</T>
      </View>
    </View>
  );
}

// ─── KPI Card ───────────────────────────────────────────────────────────────
function KpiCard({ kpi, trend, onPress }) {
  const dl = kpi.delta != null ? fmtDelta(kpi.delta, kpi.unit, kpi.kpi_key) : null;
  const compEntries = Object.entries(kpi.competitor_benchmarks ?? {}).filter(([, v]) => v != null).slice(0, 3);
  return (
    <TouchableOpacity onPress={onPress} accessibilityRole="button" accessibilityLabel={kpi.label} activeOpacity={0.8}>
      <Card style={{ gap: 8, padding: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
          <T size={12} weight="700" style={{ flex: 1 }}>{kpi.label}</T>
          <View style={{ backgroundColor: STATUS_COLOR[kpi.status], borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
            <T size={10} weight="700" color={STATUS_INK[kpi.status]}>{t(STATUS_LABEL[kpi.status] ?? 'bench.status.no_data')}</T>
          </View>
        </View>
        <T size={11} color={c.mute}>{kpi.context}</T>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <T size={32} weight="800">{fmtVal(kpi.value, kpi.unit)}</T>
          {dl ? (
            <View style={{ borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3, marginBottom: 4, backgroundColor: c.bg }}>
              <T size={11} weight="700" color={dl.color}>{dl.label}</T>
            </View>
          ) : null}
        </View>
        {trend?.length ? (
          <Sparkline trend={trend} kpiKey={kpi.kpi_key} width={120} height={26} />
        ) : null}
        <View style={{ borderTopWidth: 1, borderTopColor: c.line, paddingTop: 7 }}>
          <T size={10} color={c.mute}>
            {t('bench.target')}: {fmtVal(kpi.target_value, kpi.unit)}
            {compEntries.map(([comp, val]) => ` · ${COMP_LABEL[comp] ?? comp} ${fmtVal(val, kpi.unit)}`).join('')}
          </T>
        </View>
      </Card>
    </TouchableOpacity>
  );
}

// ─── Drill Sheet ────────────────────────────────────────────────────────────
function DrillSheet({ kpi, visible, onClose, preset, customFrom, customTo, nav }) {
  const params = useMemo(() => {
    const p = { key: kpi?.kpi_key, preset };
    if (preset === 'custom' && customFrom && customTo) { p.from = customFrom; p.to = customTo; }
    return p;
  }, [kpi?.kpi_key, preset, customFrom, customTo]);

  const bd = useLoad(
    () => visible && kpi ? api.get('/admin/benchmarks/breakdown', { ...params, dimension: 'city' }) : Promise.resolve(null),
    [visible, kpi?.kpi_key, preset]
  );
  const trendData = useLoad(
    () => visible && kpi ? api.get('/admin/benchmarks/trend', { key: kpi.kpi_key, months: 12 }) : Promise.resolve(null),
    [visible, kpi?.kpi_key]
  );
  if (!kpi) return null;
  const trendRows = trendData.data?.trend ?? [];
  return (
    <Sheet visible={visible} onClose={onClose} title={kpi.label}>
      <View style={{ gap: 14 }}>
        <Card style={{ padding: 12, gap: 6, backgroundColor: c.violetSoft }}>
          <T size={12} weight="700">{t('bench.drill.methodology')}</T>
          <T size={12} color={c.mute}>{kpi.methodology}</T>
        </Card>
        {trendRows.length > 0 && (
          <Section title={t('bench.drill.trend_12m')}>
            <Sparkline trend={trendRows} kpiKey={kpi.kpi_key} width={280} height={52} />
          </Section>
        )}
        <Section title={t('bench.drill.breakdown')}>
          {bd.loading ? <Loading /> : bd.error ? <ErrorBox error={bd.error} onRetry={bd.reload} /> : (bd.data?.rows ?? []).map((row) => (
            <Row key={row.dim_key} title={row.dim_key} sub={`${row.sample_size} ${t('bench.drill.records')}`}
              right={<T size={13} weight="700">{fmtVal(row.value, kpi.unit)}</T>} />
          ))}
        </Section>
        <Section title={t('bench.drill.competitors')}>
          {Object.entries(kpi.competitor_benchmarks ?? {}).filter(([, v]) => v != null).map(([comp, val]) => (
            <Row key={comp} title={COMP_LABEL[comp] ?? comp}
              right={<T size={13} weight="600">{fmtVal(val, kpi.unit)}</T>} />
          ))}
        </Section>
        <Btn title={t('bench.drill.view_analytics')} color={c.violetSoft} ink={c.violet}
          onPress={() => { onClose(); nav.push('Analytics'); }} />
      </View>
    </Sheet>
  );
}

// ─── Config Sheet ────────────────────────────────────────────────────────────
function ConfigSheet({ visible, onClose, configs, onSaved }) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState({});

  const setEdit = (key, field, val) =>
    setEdits((p) => ({ ...p, [key]: { ...(p[key] ?? {}), [field]: val } }));
  const setCompEdit = (key, comp, val) =>
    setEdits((p) => ({
      ...p,
      [key]: {
        ...(p[key] ?? {}),
        competitor_benchmarks: {
          ...((configs ?? []).find((c) => c.kpi_key === key)?.competitor_benchmarks ?? {}),
          ...(p[key]?.competitor_benchmarks ?? {}),
          [comp]: val === '' ? null : +val,
        },
      },
    }));

  const save = async () => {
    setBusy(true);
    try {
      await Promise.all(
        Object.entries(edits).map(([key, patch]) => api.put(`/admin/benchmarks/config/${key}`, patch))
      );
      toast(t('bench.config.saved'));
      setEdits({});
      onSaved();
      onClose();
    } catch (e) {
      toast(e.message);
    }
    setBusy(false);
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('bench.config.title')}
      footer={<Btn title={t('common.save')} onPress={save} loading={busy} color={c.pink} />}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ gap: 16, paddingBottom: 32 }}>
          {(configs ?? []).map((cfg) => {
            const e = edits[cfg.kpi_key] ?? {};
            return (
              <Section key={cfg.kpi_key} title={cfg.label}>
                <Field label={t('bench.config.target')}
                  value={String(e.target_value ?? cfg.target_value ?? '')}
                  onChangeText={(v) => setEdit(cfg.kpi_key, 'target_value', v === '' ? undefined : +v)}
                  keyboardType="decimal-pad" />
                <Field label={t('bench.config.warn')}
                  value={String(e.warn_threshold ?? cfg.warn_threshold ?? '')}
                  onChangeText={(v) => setEdit(cfg.kpi_key, 'warn_threshold', v === '' ? undefined : +v)}
                  keyboardType="decimal-pad" />
                <Field label={t('bench.config.crit')}
                  value={String(e.crit_threshold ?? cfg.crit_threshold ?? '')}
                  onChangeText={(v) => setEdit(cfg.kpi_key, 'crit_threshold', v === '' ? undefined : +v)}
                  keyboardType="decimal-pad" />
                <T size={11} weight="700" color={c.mute} style={{ marginTop: 6 }}>{t('bench.config.competitors')}</T>
                {COMPETITORS.map((comp) => {
                  const cur = (e.competitor_benchmarks ?? cfg.competitor_benchmarks ?? {})[comp];
                  return (
                    <Field key={comp} label={COMP_LABEL[comp]}
                      value={cur != null ? String(cur) : ''}
                      placeholder={t('bench.config.comp_placeholder')}
                      onChangeText={(v) => setCompEdit(cfg.kpi_key, comp, v)}
                      keyboardType="decimal-pad" />
                  );
                })}
              </Section>
            );
          })}
        </View>
      </ScrollView>
    </Sheet>
  );
}

// ─── Main Screen ─────────────────────────────────────────────────────────────
export function PlatformBenchmarks() {
  const { user } = useSession();
  const { width } = useLayout();
  const nav = useNav();
  const twoCol = width >= 768;

  const [preset, setPreset] = useState('last_30');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [drillKpi, setDrillKpi] = useState(null);
  const [showConfig, setShowConfig] = useState(false);
  const [configKey, setConfigKey] = useState(0);

  if (!user?.roles?.includes('platform_admin')) {
    return (
      <Screen title={t('bench.title')}>
        <Empty emoji="🔒" title={t('bench.locked_title')} sub={t('bench.locked_sub')} />
      </Screen>
    );
  }

  const summaryParams = useMemo(() => {
    const p = { preset };
    if (preset === 'custom' && customFrom && customTo) { p.from = customFrom; p.to = customTo; }
    return p;
  }, [preset, customFrom, customTo]);

  const summary = useLoad(
    () => api.get('/admin/benchmarks/summary', summaryParams),
    [JSON.stringify(summaryParams)]
  );
  const configs = useLoad(
    () => api.get('/admin/benchmarks/config'),
    [configKey]
  );
  const trendAll = useLoad(
    () => api.get('/admin/benchmarks/trend', { months: 12 }),
    []
  );

  const kpis = summary.data ?? [];
  const trendMap = trendAll.data ?? {};

  return (
    <Screen title={t('bench.title')} scroll={false}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} showsVerticalScrollIndicator={false}>
        {/* Command bar */}
        <View style={{ gap: 8, marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Seg value={preset} options={PRESETS} onChange={setPreset} />
            </View>
            <Btn small title={t('bench.configure')} color={c.violetSoft} ink={c.violet}
              onPress={() => setShowConfig(true)} />
          </View>
          {preset === 'custom' && (
            <DateRangeField from={customFrom} to={customTo}
              onFromChange={setCustomFrom} onToChange={setCustomTo} />
          )}
        </View>

        {/* Health strip */}
        <HealthStrip kpis={kpis} loading={summary.loading && !kpis.length} />

        {/* KPI grid */}
        <View style={{ marginTop: 12 }}>
          {summary.loading && !kpis.length ? (
            <Loading />
          ) : summary.error ? (
            <ErrorBox error={summary.error} onRetry={summary.reload} />
          ) : (
            <View style={twoCol ? { flexDirection: 'row', flexWrap: 'wrap', gap: 10 } : { gap: 10 }}>
              {kpis.map((kpi) => (
                <View key={kpi.kpi_key} style={twoCol ? { width: '48.5%' } : {}}>
                  <KpiCard
                    kpi={kpi}
                    trend={trendMap[kpi.kpi_key]}
                    onPress={() => setDrillKpi(kpi)}
                  />
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      <DrillSheet
        kpi={drillKpi}
        visible={!!drillKpi}
        onClose={() => setDrillKpi(null)}
        preset={preset}
        customFrom={customFrom}
        customTo={customTo}
        nav={nav}
      />
      <ConfigSheet
        visible={showConfig}
        onClose={() => setShowConfig(false)}
        configs={configs.data}
        onSaved={() => { setConfigKey((k) => k + 1); summary.reload?.(); }}
      />
    </Screen>
  );
}
