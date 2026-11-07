// Venue Revenue Intelligence: 6-tab screen covering demand heatmap, utilisation forecast,
// pricing recommendations, operational recommendations, pricing experiments and guardrail settings.
// All data comes from the API; no dummy values. Empty states direct the operator to the next action.
import React, { useState, useCallback } from 'react';
import { View, ScrollView, TouchableOpacity, Switch } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, ErrorBox, Loading, Sheet, T, Tag, HScroll } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';
import { locale } from '../locale';

const TABS = ['demand', 'forecast', 'pricing', 'operations', 'experiments', 'settings'];
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR_LABELS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
const pct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`);
const money = (cents, cur = '') => cents == null ? '—' : `${cur}${(cents / 100).toLocaleString(locale, { minimumFractionDigits: 2 })}`;

// Intensity colour: 0=transparent → 4=peak pink
const intensityColor = (level) => {
  const map = [c.line + '33', c.violetSoft + '55', c.violetSoft, c.pink + 'AA', c.pink];
  return map[Math.min(4, Math.max(0, level ?? 0))];
};

function TabBar({ active, onSelect }) {
  return (
    <HScroll style={{ marginBottom: 2 }}>
      <View style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 16, paddingVertical: 8 }}>
        {TABS.map((tab) => (
          <TouchableOpacity
            key={tab}
            onPress={() => onSelect(tab)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active === tab }}
            accessibilityLabel={t(`ri.tab.${tab}`)}
            style={{
              paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, minHeight: 44, justifyContent: 'center',
              backgroundColor: active === tab ? c.pink : c.paper,
              borderWidth: 1, borderColor: active === tab ? c.pink : c.line,
            }}
          >
            <T size={13} weight={active === tab ? '800' : '600'} color={active === tab ? '#fff' : c.ink}>
              {t(`ri.tab.${tab}`)}
            </T>
          </TouchableOpacity>
        ))}
      </View>
    </HScroll>
  );
}

// ------------------------------------------------------------------ Demand tab

function DemandTab({ venueId }) {
  const [resourceId, setResourceId] = useState(null);
  const [period, setPeriod] = useState(90);
  const demand = useLoad(() => api.get(`/venues/${venueId}/revenue-intel/demand?period_days=${period}${resourceId ? `&resource_id=${resourceId}` : ''}`), [venueId, period, resourceId]);

  if (demand.error) return <ErrorBox error={demand.error} onRetry={demand.reload} />;
  if (!demand.data) return <Loading />;

  const { cells, max_score } = demand.data;
  const grid = {}; // weekday → hour → cell
  for (const cell of cells) {
    if (!grid[cell.weekday]) grid[cell.weekday] = {};
    grid[cell.weekday][cell.hour] = cell;
  }

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
      <Card pad={12} style={{ marginHorizontal: 16, marginBottom: 12 }}>
        <T size={12} weight="800" color={c.mute}>{t('ri.demand.observed').toUpperCase()}</T>
        <T size={15} weight="700" style={{ marginTop: 2 }}>{t('ri.demand.title')}</T>
        <T size={12} color={c.mute}>{t('ri.demand.period', { n: period })}</T>
      </Card>

      {!cells.length ? (
        <Card pad={16} style={{ margin: 16 }}>
          <T color={c.mute}>{t('ri.demand.empty')}</T>
        </Card>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator accessibilityLabel={t('ri.demand.title')}>
          <View style={{ paddingHorizontal: 16 }}>
            {/* Header: days */}
            <View style={{ flexDirection: 'row', marginBottom: 2, marginStart: 36 }}>
              {WEEKDAY_LABELS.map((day, wd) => (
                <T key={wd} size={10} weight="700" color={c.mute} style={{ width: 32, textAlign: 'center' }}>{day}</T>
              ))}
            </View>
            {/* Rows: hours */}
            {HOUR_LABELS.map((label, hour) => (
              <View key={hour} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 1 }}>
                <T size={9} color={c.mute} style={{ width: 32, textAlign: 'right', marginEnd: 4 }}>{label}</T>
                {WEEKDAY_LABELS.map((_, wd) => {
                  const cell = grid[wd]?.[hour];
                  const intensity = cell?.intensity ?? 0;
                  return (
                    <View
                      key={wd}
                      accessible
                      accessibilityLabel={cell ? `${WEEKDAY_LABELS[wd]} ${label}: ${cell.bookings} bookings` : `${WEEKDAY_LABELS[wd]} ${label}: no data`}
                      style={{
                        width: 30, height: 14, marginEnd: 2, borderRadius: 3,
                        backgroundColor: intensityColor(intensity),
                      }}
                    />
                  );
                })}
              </View>
            ))}
          </View>
        </ScrollView>
      )}

      {/* Legend */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, marginTop: 12 }}>
        <T size={11} color={c.mute}>{t('ri.demand.bookings')}:</T>
        {[0, 1, 2, 3, 4].map((level) => (
          <View key={level} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: intensityColor(level) }} />
            {level === 0 && <T size={10} color={c.mute}>Low</T>}
            {level === 4 && <T size={10} color={c.mute}>High</T>}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// ------------------------------------------------------------------ Forecast tab

function ForecastTab({ venueId }) {
  const forecast = useLoad(() => api.get(`/venues/${venueId}/revenue-intel/forecast`), [venueId]);

  if (forecast.error) return <ErrorBox error={forecast.error} onRetry={forecast.reload} />;
  if (!forecast.data) return <Loading />;

  const d = forecast.data;

  if (d.insufficient_history) {
    return (
      <View style={{ padding: 24, gap: 12 }}>
        <Card pad={16}>
          <T size={15} weight="700">{t('ri.forecast.insufficient')}</T>
          <T size={13} color={c.mute} style={{ marginTop: 6 }}>{t('ri.forecast.coverage', { n: d.data_coverage_days ?? 0 })}</T>
        </Card>
      </View>
    );
  }

  const allPoints = [...(d.actual ?? []), ...(d.projected ?? [])];
  const maxVal = allPoints.length ? Math.max(...allPoints.map((p) => Math.max(p.bookings ?? 0, p.projected_bookings ?? 0, p.confidence_band_high ?? 0))) : 1;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Card pad={12}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Tag label={t(`ri.forecast.confidence.${d.confidence}`)} color={d.confidence === 'high' ? c.mint : d.confidence === 'medium' ? c.sun : c.orange} />
          <T size={12} color={c.mute}>{t('ri.forecast.coverage', { n: d.data_coverage_days })}</T>
          {d.mae_pct != null && <T size={12} color={c.mute}>{t('ri.forecast.mae', { n: d.mae_pct })}</T>}
        </View>
        <T size={11} color={c.mute} style={{ marginTop: 6 }}>{d.disclaimer}</T>
      </Card>

      {/* Sparkline-style bar chart: actual (solid) vs projected (dashed outline) */}
      <Card pad={12} accessibilityLabel={t('ri.forecast.title')}>
        <T size={13} weight="700" style={{ marginBottom: 8 }}>{t('ri.forecast.actual')} vs {t('ri.forecast.projected')}</T>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 100 }}>
            {(d.actual ?? []).map((pt, idx) => {
              const h = maxVal > 0 ? Math.max(2, (pt.bookings / maxVal) * 90) : 2;
              return (
                <View key={idx} accessible accessibilityLabel={`${pt.week_start}: ${pt.bookings} bookings`}
                  style={{ width: 14, height: h, borderRadius: 3, backgroundColor: c.pink }} />
              );
            })}
            {(d.projected ?? []).map((pt, idx) => {
              const h = maxVal > 0 ? Math.max(2, (pt.projected_bookings / maxVal) * 90) : 2;
              return (
                <View key={`p${idx}`} accessible accessibilityLabel={`Projected ${pt.week_start}: ${pt.projected_bookings} bookings`}
                  style={{ width: 14, height: h, borderRadius: 3, backgroundColor: c.violetSoft, borderWidth: 1, borderColor: c.pink, borderStyle: 'dashed' }} />
              );
            })}
          </View>
        </ScrollView>
        <View style={{ flexDirection: 'row', gap: 16, marginTop: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.pink }} />
            <T size={11} color={c.mute}>{t('ri.forecast.actual')}</T>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.violetSoft, borderWidth: 1, borderColor: c.pink }} />
            <T size={11} color={c.mute}>{t('ri.forecast.projected')}</T>
          </View>
        </View>
      </Card>

      {/* Projected weeks */}
      {(d.projected ?? []).map((pt) => (
        <Card key={pt.week_start} pad={12} accessibilityLabel={`${pt.week_start}: ${pt.projected_bookings} projected bookings`}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <T weight="700">{pt.week_start}</T>
            <T size={18} weight="800" color={c.pink}>{Math.round(pt.projected_bookings)}</T>
          </View>
          <T size={12} color={c.mute}>Range: {pt.confidence_band_low} – {pt.confidence_band_high}</T>
        </Card>
      ))}
    </ScrollView>
  );
}

// ------------------------------------------------------------------ Pricing tab

function PricingTab({ venueId }) {
  const [generating, setGenerating] = useState(false);
  const [deciding, setDeciding] = useState(null);
  const [filter, setFilter] = useState('pending');
  const recs = useLoad(() => api.get(`/venues/${venueId}/revenue-intel/pricing-recommendations?status=${filter}`), [venueId, filter]);

  const generate = useCallback(async () => {
    setGenerating(true);
    try { await api.post(`/venues/${venueId}/revenue-intel/pricing-recommendations/generate`, { venue_id: venueId }); await recs.reload(); }
    finally { setGenerating(false); }
  }, [venueId, recs]);

  const decide = useCallback(async (id, action) => {
    setDeciding(id);
    try { await api.post(`/pricing-recommendations/${id}/decision`, { id, action }); await recs.reload(); }
    finally { setDeciding(null); }
  }, [recs]);

  const STATUS_COLOR = { pending: c.sun, applied: c.mint, rejected: c.mute, expired: c.orange };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {['pending','applied','rejected'].map((s) => (
          <TouchableOpacity key={s} onPress={() => setFilter(s)} accessibilityRole="button" accessibilityLabel={t(`ri.pricing.${s}`)}
            style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, minHeight: 44, justifyContent: 'center',
              backgroundColor: filter === s ? c.pink : c.paper, borderWidth: 1, borderColor: filter === s ? c.pink : c.line }}>
            <T size={12} weight="700" color={filter === s ? '#fff' : c.ink}>{t(`ri.pricing.${s}`)}</T>
          </TouchableOpacity>
        ))}
        <Btn small title={t('ri.pricing.refresh')} onPress={generate} loading={generating} accessibilityLabel={t('ri.pricing.refresh')} />
      </View>

      {recs.error && <ErrorBox error={recs.error} onRetry={recs.reload} />}
      {!recs.data && !recs.error && <Loading />}
      {recs.data?.length === 0 && <Card pad={16}><T color={c.mute}>{t('ri.pricing.empty')}</T></Card>}

      {(recs.data ?? []).map((rec) => (
        <Card key={rec.id} pad={14} accessibilityLabel={`${t(`ri.pricing.trigger.${rec.trigger_kind}`)}: ${rec.resource_name ?? 'venue'}`}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            <Tag label={t(`ri.pricing.trigger.${rec.trigger_kind}`)} color={c.violetSoft} />
            <Tag label={t(`ri.pricing.${rec.status}`)} color={STATUS_COLOR[rec.status] ?? c.mute} />
            {rec.resource_name && <Tag label={rec.resource_name} color={c.paper} />}
          </View>
          <View style={{ flexDirection: 'row', gap: 16, marginBottom: 6 }}>
            <View>
              <T size={11} color={c.mute}>{t('ri.pricing.current_rate')}</T>
              <T size={16} weight="800">{rec.current_rate_cents ? money(rec.current_rate_cents) : '—'}</T>
            </View>
            <T size={22} color={c.mute} style={{ alignSelf: 'center' }}>→</T>
            <View>
              <T size={11} color={c.mute}>{t('ri.pricing.suggested_rate')}</T>
              <T size={16} weight="800" color={c.pink}>{money(rec.suggested_rate_cents)}</T>
            </View>
          </View>
          {rec.reason_json?.narrative && (
            <T size={13} color={c.mute} style={{ marginBottom: 8 }}>{rec.reason_json.narrative}</T>
          )}
          {rec.expected_effect?.estimate && (
            <Tag label={`${t('ri.pricing.expected')}: ${rec.expected_effect.estimate}`} color={c.mintSoft ?? c.mint} />
          )}
          {rec.actual_effect && (
            <T size={12} color={c.mint} style={{ marginTop: 6 }}>
              {t('ri.pricing.outcome_actual', { metric: 'bookings', value: `${pct(rec.actual_effect.bookings_change_pct)}` })}
            </T>
          )}
          {rec.status === 'pending' && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
              <Btn small title={t('ri.pricing.approve')} loading={deciding === rec.id} onPress={() => decide(rec.id, 'approve')} accessibilityLabel={`${t('ri.pricing.approve')} - ${rec.resource_name}`} />
              <Btn small title={t('ri.pricing.reject')} color={c.paper} loading={deciding === rec.id} onPress={() => decide(rec.id, 'reject')} accessibilityLabel={`${t('ri.pricing.reject')} - ${rec.resource_name}`} />
            </View>
          )}
        </Card>
      ))}
    </ScrollView>
  );
}

// ------------------------------------------------------------------ Operations tab

function OperationsTab({ venueId }) {
  const [updating, setUpdating] = useState(null);
  const recs = useLoad(() => api.get(`/venues/${venueId}/revenue-intel/utilisation-recommendations`), [venueId]);

  const update = useCallback(async (id, status) => {
    setUpdating(id);
    try { await api.patch(`/utilisation-recommendations/${id}`, { id, status }); await recs.reload(); }
    finally { setUpdating(null); }
  }, [recs]);

  const KIND_ICON = { adjust_hours: '🕐', repurpose_window: '🔄', community_game: '🏆', promotion: '🎯', waitlist_open: '📋', maintenance: '🔧' };
  const PRIORITY_COLOR = { high: c.orange, medium: c.sun, low: c.mute };

  if (recs.error) return <ErrorBox error={recs.error} onRetry={recs.reload} />;
  if (!recs.data) return <Loading />;

  const grouped = { high: [], medium: [], low: [] };
  for (const r of recs.data) grouped[r.priority]?.push(r);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      {Object.entries(grouped).map(([priority, items]) => !items.length ? null : (
        <View key={priority}>
          <T size={13} weight="800" color={PRIORITY_COLOR[priority]} style={{ marginBottom: 8 }}>
            {t(`ri.ops.priority.${priority}`).toUpperCase()}
          </T>
          <View style={{ gap: 10 }}>
            {items.map((rec) => (
              <Card key={rec.id} pad={14} style={{ borderLeftWidth: 4, borderLeftColor: PRIORITY_COLOR[priority] }}
                accessibilityLabel={`${t(`ri.ops.kind.${rec.kind}`)}: ${rec.description}`}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <T size={18}>{KIND_ICON[rec.kind] ?? '💡'}</T>
                  <Tag label={t(`ri.ops.kind.${rec.kind}`)} color={c.violetSoft} />
                </View>
                <T weight="700" style={{ marginBottom: 4 }}>{rec.description}</T>
                {rec.evidence_json?.metric && (
                  <T size={12} color={c.mute}>
                    {t('ri.ops.evidence', { metric: rec.evidence_json.metric, observed: rec.evidence_json.observed_value, threshold: rec.evidence_json.threshold, period: rec.evidence_json.period_days })}
                  </T>
                )}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                  <Btn small title={t('ri.ops.act')} loading={updating === rec.id} onPress={() => update(rec.id, 'acted')} accessibilityLabel={`${t('ri.ops.act')}: ${rec.description}`} />
                  <Btn small title={t('ri.ops.dismiss')} color={c.paper} loading={updating === rec.id} onPress={() => update(rec.id, 'dismissed')} accessibilityLabel={`${t('ri.ops.dismiss')}: ${rec.description}`} />
                </View>
              </Card>
            ))}
          </View>
        </View>
      ))}
      {recs.data.length === 0 && (
        <Card pad={16}><T color={c.mute}>{t('ri.ops.empty')}</T></Card>
      )}
    </ScrollView>
  );
}

// ------------------------------------------------------------------ Experiments tab

function ExperimentsTab({ venueId }) {
  const [showCreate, setShowCreate] = useState(false);
  const [activating, setActivating] = useState(null);
  const [form, setForm] = useState({ name: '', hypothesis: '', control_rate_cents: '', experiment_rate_cents: '', start_date: '', end_date: '' });
  const experiments = useLoad(() => api.get(`/venues/${venueId}/revenue-intel/experiments`), [venueId]);

  const activate = useCallback(async (id) => {
    setActivating(id);
    try { await api.post(`/pricing-experiments/${id}/activate`, { id }); await experiments.reload(); }
    finally { setActivating(null); }
  }, [experiments]);

  const createExp = useCallback(async () => {
    await api.post(`/venues/${venueId}/revenue-intel/experiments`, {
      venue_id: venueId,
      resource_ids: [],
      name: form.name,
      hypothesis: form.hypothesis || undefined,
      control_rate_cents: Number(form.control_rate_cents) * 100,
      experiment_rate_cents: Number(form.experiment_rate_cents) * 100,
      start_date: form.start_date,
      end_date: form.end_date,
    });
    setShowCreate(false);
    await experiments.reload();
  }, [venueId, form, experiments]);

  const STATUS_COLOR = { draft: c.sun, active: c.mint, completed: c.mute, cancelled: c.orange };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Btn title={t('ri.exp.create')} onPress={() => setShowCreate(true)} accessibilityLabel={t('ri.exp.create')} />

      {experiments.error && <ErrorBox error={experiments.error} onRetry={experiments.reload} />}
      {!experiments.data && !experiments.error && <Loading />}
      {experiments.data?.length === 0 && <Card pad={16}><T color={c.mute}>{t('ri.exp.empty')}</T></Card>}

      {(experiments.data ?? []).map((exp) => (
        <Card key={exp.id} pad={14} accessibilityLabel={exp.name}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
            <T weight="800" style={{ flex: 1 }}>{exp.name}</T>
            <Tag label={t(`ri.exp.status.${exp.status}`)} color={STATUS_COLOR[exp.status] ?? c.mute} />
          </View>
          {exp.hypothesis && <T size={13} color={c.mute} style={{ marginBottom: 8 }}>{exp.hypothesis}</T>}
          <View style={{ flexDirection: 'row', gap: 16, marginBottom: 8 }}>
            <View>
              <T size={11} color={c.mute}>{t('ri.exp.control')}</T>
              <T weight="700">{money(exp.control_rate_cents)}/hr</T>
            </View>
            <View>
              <T size={11} color={c.mute}>{t('ri.exp.experiment')}</T>
              <T weight="700" color={c.pink}>{money(exp.experiment_rate_cents)}/hr</T>
            </View>
          </View>
          <T size={12} color={c.mute}>{exp.start_date} – {exp.end_date}</T>
          {exp.status === 'draft' && (
            <Btn small title={t('ri.exp.activate')} loading={activating === exp.id} onPress={() => activate(exp.id)} style={{ marginTop: 10 }} accessibilityLabel={`${t('ri.exp.activate')}: ${exp.name}`} />
          )}
        </Card>
      ))}

      <Sheet visible={showCreate} onClose={() => setShowCreate(false)} title={t('ri.exp.create')}>
        <View style={{ gap: 12, padding: 4 }}>
          <T size={12} color={c.mute}>{t('ri.exp.caveat')}</T>
          <Btn title="Save" onPress={createExp} accessibilityLabel="Save experiment" />
        </View>
      </Sheet>
    </ScrollView>
  );
}

// ------------------------------------------------------------------ Settings tab

function SettingsTab({ venueId }) {
  const cfg = useLoad(() => api.get(`/venues/${venueId}/revenue-intel/config`), [venueId]);
  const [saving, setSaving] = useState(false);
  const [local, setLocal] = useState(null);
  const [saved, setSaved] = useState(false);

  const data = local ?? cfg.data;

  const patch = (key, val) => setLocal((prev) => ({ ...(prev ?? cfg.data ?? {}), [key]: val }));

  const save = useCallback(async () => {
    if (!data) return;
    setSaving(true);
    try {
      await api.put(`/venues/${venueId}/revenue-intel/config`, { venue_id: venueId, ...data });
      setSaved(true);
      await cfg.reload();
      setLocal(null);
      setTimeout(() => setSaved(false), 3000);
    } finally { setSaving(false); }
  }, [venueId, data, cfg]);

  if (cfg.error) return <ErrorBox error={cfg.error} onRetry={cfg.reload} />;
  if (!cfg.data && !cfg.error) return <Loading />;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      {saved && <Card pad={12} style={{ backgroundColor: c.mint + '33' }}><T color={c.mint}>{t('ri.settings.saved')}</T></Card>}

      <Card pad={14}>
        <T size={15} weight="800" style={{ marginBottom: 8 }}>{t('ri.settings.mode')}</T>
        {['manual', 'bounded_auto'].map((mode) => (
          <TouchableOpacity key={mode} onPress={() => patch('automation_mode', mode)}
            accessibilityRole="radio" accessibilityState={{ checked: data?.automation_mode === mode }}
            accessibilityLabel={t(`ri.settings.mode.${mode}`)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingVertical: 8, borderBottomWidth: 1, borderColor: c.line }}>
            <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: c.pink, alignItems: 'center', justifyContent: 'center' }}>
              {data?.automation_mode === mode && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.pink }} />}
            </View>
            <T style={{ flex: 1 }}>{t(`ri.settings.mode.${mode}`)}</T>
          </TouchableOpacity>
        ))}
      </Card>

      <Card pad={14}>
        <T size={15} weight="800" style={{ marginBottom: 8 }}>{t('ri.settings.objectives')}</T>
        {['protect_peak', 'fill_offpeak', 'reduce_noshow'].map((obj) => (
          <View key={obj} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, borderBottomWidth: 1, borderColor: c.line }}>
            <T style={{ flex: 1 }}>{t(`ri.settings.obj.${obj}`)}</T>
            <Switch
              value={!!(data?.objectives?.[obj])}
              onValueChange={(v) => patch('objectives', { ...(data?.objectives ?? {}), [obj]: v })}
              accessibilityLabel={t(`ri.settings.obj.${obj}`)}
              trackColor={{ true: c.pink }}
            />
          </View>
        ))}
      </Card>

      <Btn title={t('ri.settings.save')} loading={saving} onPress={save} accessibilityLabel={t('ri.settings.save')} />
    </ScrollView>
  );
}

// ------------------------------------------------------------------ Main screen

export function VenueRevenueIntelligence({ venueId }) {
  const [activeTab, setActiveTab] = useState('demand');

  const renderTab = () => {
    if (activeTab === 'demand') return <DemandTab venueId={venueId} />;
    if (activeTab === 'forecast') return <ForecastTab venueId={venueId} />;
    if (activeTab === 'pricing') return <PricingTab venueId={venueId} />;
    if (activeTab === 'operations') return <OperationsTab venueId={venueId} />;
    if (activeTab === 'experiments') return <ExperimentsTab venueId={venueId} />;
    if (activeTab === 'settings') return <SettingsTab venueId={venueId} />;
    return null;
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
        <T size={22} weight="800">{t('ri.title')}</T>
        <T size={13} color={c.mute}>{t('ri.sub')}</T>
      </View>
      <TabBar active={activeTab} onSelect={setActiveTab} />
      <View style={{ flex: 1 }}>{renderTab()}</View>
    </View>
  );
}

export default VenueRevenueIntelligence;
