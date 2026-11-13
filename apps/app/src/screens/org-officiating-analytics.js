// Organiser officiating analytics dashboard (REF-R27 / issue #1025).
// Pool KPIs, assignment funnel, season intelligence, leaderboard and CSV export.
// API-first, MCP-enabled, audit-logged.
import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { saveExport } from '../open-file';
import { Btn, Card, Empty, ErrorBox, Loading, Row, Screen, Section, Seg, StatPill, T } from '../ui';
import { DateRangeField } from '../pickers';
import { c } from '../theme';
import { t } from '../i18n';

const TABS = [
  { value: 'overview',    label: () => t('orgOfficialAnalytics.tabs.overview') },
  { value: 'pool',        label: () => t('orgOfficialAnalytics.tabs.pool') },
  { value: 'funnel',      label: () => t('orgOfficialAnalytics.tabs.funnel') },
  { value: 'season',      label: () => t('orgOfficialAnalytics.tabs.season') },
  { value: 'leaderboard', label: () => t('orgOfficialAnalytics.tabs.leaderboard') },
  { value: 'export',      label: () => t('orgOfficialAnalytics.tabs.export') },
];

// ── Overview ───────────────────────────────────────────────────────────────

function OverviewTab({ orgId, from, to }) {
  const params = { ...(from && { from }), ...(to && { to }) };
  const kpis = useLoad(() => api.get(`/organisations/${orgId}/officiating-analytics/kpis`, params), [orgId, from, to]);

  if (kpis.loading) return <Loading />;
  if (kpis.error) return <ErrorBox error={kpis.error} />;
  const d = kpis.data ?? {};

  if (!d.total_assignments && !d.unique_officials) {
    return <Empty icon="📊" title={t('orgOfficialAnalytics.empty')} />;
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      <Section title={t('orgOfficialAnalytics.kpi.strip')}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <StatPill value={String(d.unique_officials ?? 0)} label={t('orgOfficialAnalytics.kpi.poolSize')} color={c.info} />
          <StatPill value={String(d.total_assignments ?? 0)} label={t('orgOfficialAnalytics.kpi.totalAssignments')} color={c.violet} />
          <StatPill value={d.acceptance_rate != null ? `${d.acceptance_rate}%` : '—'} label={t('orgOfficialAnalytics.kpi.acceptance')} color={c.positive} />
          <StatPill value={d.avg_fee_minor != null ? `${(d.avg_fee_minor / 100).toFixed(2)} ${d.fee_currency ?? ''}` : '—'} label={t('orgOfficialAnalytics.kpi.avgFee')} color={c.warn} />
          <StatPill value={String(d.incident_count ?? 0)} label={t('orgOfficialAnalytics.kpi.incidents')} color={d.incident_count > 0 ? c.danger : c.mute} />
        </View>
      </Section>
    </ScrollView>
  );
}

// ── Pool ───────────────────────────────────────────────────────────────────

function PoolTab({ orgId, from, to }) {
  const params = { ...(from && { from }), ...(to && { to }) };
  const data = useLoad(() => api.get(`/organisations/${orgId}/officiating-analytics/pool`, params), [orgId, from, to]);

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const rows = data.data?.breakdown ?? [];

  if (!rows.length) {
    return <Empty icon="👥" title={t('orgOfficialAnalytics.pool.empty')} />;
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      <Section title={t('orgOfficialAnalytics.pool.title')}>
        {rows.map((r, i) => (
          <Card key={i} pad={12} style={{ marginBottom: 8 }}>
            <T weight="600" size={14}>{r.sport_emoji ?? ''} {r.sport_name ?? r.sport_id}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
              {r.role && <T size={12} color={c.info}>{t('orgOfficialAnalytics.pool.role')}: {r.role}</T>}
              {r.level && <T size={12} color={c.violet}>{t('orgOfficialAnalytics.pool.level')}: {r.level}</T>}
              <T size={12}>{t('orgOfficialAnalytics.pool.count')}: {r.official_count ?? r.count ?? 0}</T>
            </View>
          </Card>
        ))}
      </Section>
    </ScrollView>
  );
}

// ── Funnel ─────────────────────────────────────────────────────────────────

function FunnelTab({ orgId, from, to }) {
  const params = { ...(from && { from }), ...(to && { to }) };
  const data = useLoad(() => api.get(`/organisations/${orgId}/officiating-analytics/funnel`, params), [orgId, from, to]);

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const rows = data.data?.monthly ?? [];

  if (!rows.length) {
    return <Empty icon="🔽" title={t('orgOfficialAnalytics.funnel.empty')} />;
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      {data.data?.totals && (
        <Section title={t('orgOfficialAnalytics.funnel.title')}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <StatPill value={String(data.data.totals.accepted ?? 0)} label={t('orgOfficialAnalytics.funnel.accepted')} color={c.positive} />
            <StatPill value={String(data.data.totals.declined ?? 0)} label={t('orgOfficialAnalytics.funnel.declined')} color={c.danger} />
            <StatPill value={String(data.data.totals.cancelled ?? 0)} label={t('orgOfficialAnalytics.funnel.cancelled')} color={c.warn} />
          </View>
        </Section>
      )}
      <Section>
        {rows.map((m) => (
          <Card key={m.month} pad={12} style={{ marginBottom: 6 }}>
            <Row
              label={m.month}
              right={`✓${m.accepted ?? 0} ✗${m.declined ?? 0}`}
            />
          </Card>
        ))}
      </Section>
    </ScrollView>
  );
}

// ── Season Intelligence ────────────────────────────────────────────────────

function SeasonTab({ orgId, from, to }) {
  const params = { ...(from && { season_from: from }), ...(to && { season_to: to }) };
  const data = useLoad(() => api.get(`/organisations/${orgId}/officiating-analytics/season-intelligence`, params), [orgId, from, to]);

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const seasons = data.data?.seasons ?? [];

  if (!seasons.length) {
    return <Empty icon="📆" title={t('orgOfficialAnalytics.season.empty')} />;
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      <Section title={t('orgOfficialAnalytics.season.title')}>
        {seasons.map((s) => (
          <Card key={s.sport_id} pad={12} style={{ marginBottom: 10 }}>
            <T weight="600">{s.sport_emoji ?? ''} {s.sport_name ?? s.sport_id}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              <StatPill value={String(s.total_assignments ?? 0)} label={t('orgOfficialAnalytics.season.games')} color={c.info} />
              <StatPill value={String(s.unique_officials ?? 0)} label={t('orgOfficialAnalytics.season.officials')} color={c.violet} />
              <StatPill value={s.acceptance_rate != null ? `${s.acceptance_rate}%` : '—'} label={t('orgOfficialAnalytics.season.acceptance')} color={c.positive} />
              {s.avg_fee_minor != null && (
                <StatPill value={`${(s.avg_fee_minor / 100).toFixed(2)} ${s.fee_currency ?? ''}`} label={t('orgOfficialAnalytics.season.avgFee')} color={c.warn} />
              )}
            </View>
          </Card>
        ))}
      </Section>
    </ScrollView>
  );
}

// ── Leaderboard ────────────────────────────────────────────────────────────

function LeaderboardTab({ orgId, from, to }) {
  const [rankBy, setRankBy] = useState('games');
  const params = { rank_by: rankBy, ...(from && { from }), ...(to && { to }) };
  const data = useLoad(() => api.get(`/organisations/${orgId}/officiating-analytics/leaderboard`, params), [orgId, rankBy, from, to]);

  const RANK_OPTIONS = [
    { value: 'games',           label: () => t('orgOfficialAnalytics.leaderboard.byGames') },
    { value: 'hours',           label: () => t('orgOfficialAnalytics.leaderboard.byHours') },
    { value: 'acceptance_rate', label: () => t('orgOfficialAnalytics.leaderboard.byAcceptance') },
  ];

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const officials = data.data?.officials ?? [];

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      <View style={{ paddingTop: 4 }}>
        <Seg tabs={RANK_OPTIONS} value={rankBy} onChange={setRankBy} />
      </View>
      {officials.length === 0
        ? <Empty icon="🏆" title={t('orgOfficialAnalytics.leaderboard.empty')} />
        : (
          <Section title={t('orgOfficialAnalytics.leaderboard.title')}>
            {officials.map((o) => (
              <Card key={o.user_id} pad={12} style={{ marginBottom: 8 }}>
                <Row
                  label={`${o.rank}. ${o.display_name}`}
                  right={
                    rankBy === 'games' ? `${o.games}g`
                    : rankBy === 'hours' ? `${o.hours_est}h`
                    : `${o.acceptance_rate ?? '—'}%`
                  }
                />
                <T size={12} color={c.mute} style={{ marginTop: 4 }}>
                  {o.sport_names?.join(' · ') ?? ''}
                </T>
              </Card>
            ))}
          </Section>
        )
      }
    </ScrollView>
  );
}

// ── Export ─────────────────────────────────────────────────────────────────

function ExportTab({ orgId }) {
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [exporting, setExporting] = useState(false);

  const onExport = async () => {
    setExporting(true);
    try {
      const params = { ...(from && { from }), ...(to && { to }) };
      const res = await api.get(`/organisations/${orgId}/officiating-analytics/export`, params);
      await saveExport(res);
    } finally {
      setExporting(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      <Section title={t('orgOfficialAnalytics.export.title')}>
        <DateRangeField
          fromValue={from}
          toValue={to}
          onFromChange={setFrom}
          onToChange={setTo}
          label={t('orgOfficialAnalytics.export.dateRange')}
        />
        <Btn
          label={exporting ? t('orgOfficialAnalytics.export.exporting') : t('orgOfficialAnalytics.export.button')}
          disabled={exporting}
          onPress={onExport}
          style={{ marginTop: 16 }}
        />
      </Section>
    </ScrollView>
  );
}

// ── Root screen ────────────────────────────────────────────────────────────

export default function OrgOfficiatingAnalyticsScreen({ route }) {
  const orgId = route?.params?.orgId;
  const [tab, setTab] = useState('overview');
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);

  const showDateFilter = ['overview', 'pool', 'funnel', 'season', 'leaderboard'].includes(tab);

  return (
    <Screen title={t('orgOfficialAnalytics.title')}>
      <Seg tabs={TABS} value={tab} onChange={setTab} />
      {showDateFilter && (
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <DateRangeField
            fromValue={from}
            toValue={to}
            onFromChange={setFrom}
            onToChange={setTo}
            label={t('common.dateRange')}
          />
        </View>
      )}
      <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 8 }}>
        {tab === 'overview'    && <OverviewTab    orgId={orgId} from={from} to={to} />}
        {tab === 'pool'        && <PoolTab        orgId={orgId} from={from} to={to} />}
        {tab === 'funnel'      && <FunnelTab      orgId={orgId} from={from} to={to} />}
        {tab === 'season'      && <SeasonTab      orgId={orgId} from={from} to={to} />}
        {tab === 'leaderboard' && <LeaderboardTab orgId={orgId} from={from} to={to} />}
        {tab === 'export'      && <ExportTab      orgId={orgId} />}
      </View>
    </Screen>
  );
}
