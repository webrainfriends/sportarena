// Clinician practice dashboard (#210).
// Metric strip (appointments/no-shows/flare-ups/revenue), patient adherence heatmap, alert feed.
import React, { useState } from 'react';
import { View, ScrollView, TouchableOpacity } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Loading, Seg, T, Tag } from '../ui';
import { c, day } from '../theme';
import { t } from '../i18n';

const ALERT_KIND_COLOR = {
  pain_spike: c.red, missed_sessions: c.orange,
  symptom_deterioration: c.red, review_due: c.violet,
  flareup_triggered: c.orange, intake_flagged: c.pink,
};

function MetricStrip({ data }) {
  const items = [
    { label: t('physio.dashboard.today'), value: data?.today ?? '—', color: c.mint },
    { label: t('physio.dashboard.week'), value: data?.week ?? '—', color: c.violet },
    { label: t('physio.dashboard.no_shows'), value: data?.no_shows_30d ?? '—', color: data?.no_shows_30d > 0 ? c.orange : c.mute },
    { label: t('physio.dashboard.open_flareups'), value: data?.open_flareups ?? '—', color: data?.open_flareups > 0 ? c.red : c.mute },
  ];
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {items.map((m) => (
        <Card key={m.label} pad={10} color={c.paper} style={{ flex: 1, alignItems: 'center', gap: 2 }}>
          <T weight="900" size={22} color={m.color}>{m.value}</T>
          <T size={11} color={c.mute} style={{ textAlign: 'center' }}>{m.label}</T>
        </Card>
      ))}
    </View>
  );
}

function AdherenceDot({ pct }) {
  const color = pct == null ? c.line : pct >= 80 ? c.mint : pct >= 50 ? c.orange : c.red;
  return (
    <View
      accessibilityLabel={pct != null ? `${pct}%` : t('physio.dashboard.no_data')}
      style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: color }}
    />
  );
}

function PatientsTab() {
  const data = useLoad(() => api.get('/physio/patients'), []);

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  const rows = data.data ?? [];

  if (!rows.length) return <Empty emoji="🧑‍⚕️" title={t('physio.dashboard.no_patients')} sub="" />;

  return (
    <View style={{ gap: 8 }}>
      {rows.map((p) => (
        <Card key={p.patient_id} pad={10} color={c.paper}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <T weight="700">{p.patient_name ?? p.patient_id.slice(0, 8)}</T>
              <T size={11} color={c.mute}>{p.last_session ? day(p.last_session) : t('physio.dashboard.no_sessions')}</T>
            </View>
            <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
              <AdherenceDot pct={p.adherence_pct} />
              {p.adherence_pct != null && <T size={12} weight="700">{p.adherence_pct}%</T>}
            </View>
          </View>
        </Card>
      ))}
    </View>
  );
}

function AlertsTab() {
  const { toast } = useSession();
  const data = useLoad(() => api.get('/physio/alerts'), []);

  const acknowledge = async (ids) => {
    try {
      await api.post('/physio/alerts/acknowledge', { alert_ids: ids });
      toast(t('physio.dashboard.acknowledged'));
      data.reload();
    } catch (e) {
      toast(e.message ?? t('error.generic'));
    }
  };

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  const rows = data.data ?? [];

  if (!rows.length) return <Empty emoji="✅" title={t('physio.dashboard.no_alerts')} sub="" />;

  return (
    <View style={{ gap: 8 }}>
      {rows.map((a) => (
        <Card key={a.id} pad={10} color={c.paper}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Tag label={a.kind.replace(/_/g, ' ')} color={ALERT_KIND_COLOR[a.kind] ?? c.violetSoft} />
              <T size={12} color={c.mute}>{day(a.created_at)}</T>
            </View>
            {a.status === 'new' && (
              <Btn
                small
                title={t('physio.dashboard.acknowledge')}
                color={c.violet}
                onPress={() => acknowledge([a.id])}
                accessibilityLabel={t('physio.dashboard.acknowledge')}
              />
            )}
            {a.status !== 'new' && <Tag label={a.status} color={c.line} />}
          </View>
        </Card>
      ))}
    </View>
  );
}

export function PhysioDashboard() {
  const [tab, setTab] = useState('overview');
  const dashboard = useLoad(() => api.get('/physio/dashboard'), []);

  return (
    <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 32 }}>
      <Card pad={12} color={c.violetSoft}>
        <T weight="900" size={16}>{t('physio.dashboard.title')}</T>
      </Card>

      {dashboard.data && <MetricStrip data={dashboard.data} />}

      <Seg
        options={[
          { value: 'overview', label: t('physio.dashboard.overview'), emoji: '🏠' },
          { value: 'patients', label: t('physio.dashboard.patients'), emoji: '🧑‍⚕️' },
          { value: 'alerts', label: t('physio.dashboard.alerts'), emoji: '🔔' },
        ]}
        value={tab} onChange={setTab} color={c.violet}
      />

      {tab === 'overview' && dashboard.data && (
        <View style={{ gap: 8 }}>
          <Card pad={12} color={c.paper}>
            <T weight="700">{t('physio.dashboard.compliance_rate')}</T>
            <T size={22} weight="900" color={c.mint}>{dashboard.data.compliance_rate ?? '—'}%</T>
          </Card>
          <Card pad={12} color={c.paper}>
            <T weight="700">{t('physio.dashboard.revenue_month')}</T>
            <T size={22} weight="900" color={c.violet}>{dashboard.data.revenue_month ?? '—'}</T>
          </Card>
        </View>
      )}

      {tab === 'patients' && <PatientsTab />}
      {tab === 'alerts' && <AlertsTab />}
    </ScrollView>
  );
}

export default PhysioDashboard;
