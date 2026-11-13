// Referee/umpire officiating analytics dashboard (REF-R27 / issue #1025).
// Self-view: KPIs, assignment funnel, sport & role breakdown, utilisation, repeat clients,
// accreditation progress, incident trend and season summaries. API-first, MCP-enabled.
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
  { value: 'overview',      label: () => t('officialAnalytics.tabs.overview') },
  { value: 'funnel',        label: () => t('officialAnalytics.tabs.funnel') },
  { value: 'sportRole',     label: () => t('officialAnalytics.tabs.sportRole') },
  { value: 'utilisation',   label: () => t('officialAnalytics.tabs.utilisation') },
  { value: 'clients',       label: () => t('officialAnalytics.tabs.clients') },
  { value: 'accreditation', label: () => t('officialAnalytics.tabs.accreditation') },
  { value: 'incidents',     label: () => t('officialAnalytics.tabs.incidents') },
];

// ── Overview ───────────────────────────────────────────────────────────────

function OverviewTab({ from, to }) {
  const params = from && to ? { from, to } : {};
  const kpis = useLoad(() => api.get('/me/officials/analytics/kpis', params), [from, to]);
  const season = useLoad(() => api.get('/me/officials/analytics/season-summary', {}), []);
  const [exporting, setExporting] = useState(false);

  const onExport = async () => {
    setExporting(true);
    try {
      const res = await api.get('/me/officials/analytics/export', params);
      await saveExport(res);
    } finally {
      setExporting(false);
    }
  };

  if (kpis.loading) return <Loading />;
  if (kpis.error) return <ErrorBox error={kpis.error} />;
  const d = kpis.data ?? {};

  if (!d.total_games && !d.sports_count) {
    return <Empty icon="📊" title={t('officialAnalytics.empty')} />;
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      <Section title={t('officialAnalytics.kpi.strip')}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <StatPill value={String(d.total_games ?? 0)} label={t('officialAnalytics.kpi.totalGames')} color={c.info} />
          <StatPill value={`${Number(d.hours_est ?? 0).toFixed(1)}h`} label={t('officialAnalytics.kpi.totalHours')} color={c.violet} />
          <StatPill value={String(d.sports_count ?? 0)} label={t('officialAnalytics.kpi.sports')} color={c.pink} />
          <StatPill value={d.utilisation_pct != null ? `${d.utilisation_pct}%` : '—'} label={t('officialAnalytics.kpi.utilisation')} color={c.positive} />
          <StatPill value={d.acceptance_rate != null ? `${d.acceptance_rate}%` : '—'} label={t('officialAnalytics.kpi.acceptance')} color={c.warn} />
          <StatPill value={d.avg_fee_minor != null ? `${(d.avg_fee_minor / 100).toFixed(2)} ${d.fee_currency ?? ''}` : '—'} label={t('officialAnalytics.kpi.avgFee')} />
        </View>
      </Section>

      {/* Season summary cards */}
      {!season.loading && !season.error && (season.data?.summaries?.length > 0) && (
        <Section title={t('officialAnalytics.season.title')}>
          {season.data.summaries.map((s) => (
            <Card key={s.id} pad={12} style={{ marginBottom: 8 }}>
              <Row
                label={`${s.sport_emoji ?? ''} ${s.sport_name ?? ''} — ${s.season_label}`}
                right={`${s.total_games}g · ${Number(s.total_hours).toFixed(1)}h`}
              />
              <T size={12} color={c.mute} style={{ marginTop: 4 }}>
                {t('officialAnalytics.season.accepted')}: {s.accepted_count} · {t('officialAnalytics.season.declined')}: {s.declined_count}
              </T>
            </Card>
          ))}
          <Btn
            label={t('officialAnalytics.season.recompute')}
            variant="ghost"
            onPress={() => api.post('/me/officials/analytics/season-summary/recompute', {
              season_from: from ?? new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10),
              season_to: to ?? new Date().toISOString().slice(0, 10),
              season_label: String(new Date().getFullYear()),
            }).then(() => season.reload?.())}
          />
        </Section>
      )}

      <Section>
        <Btn
          label={exporting ? t('officialAnalytics.export.exporting') : t('officialAnalytics.export.button')}
          disabled={exporting}
          onPress={onExport}
        />
      </Section>
    </ScrollView>
  );
}

// ── Funnel ─────────────────────────────────────────────────────────────────

function FunnelTab({ from, to }) {
  const params = from && to ? { from, to } : {};
  const data = useLoad(() => api.get('/me/officials/analytics/funnel', params), [from, to]);

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const rows = data.data?.monthly ?? [];

  if (!rows.length) {
    return <Empty icon="🔽" title={t('officialAnalytics.funnel.empty')} />;
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      <Section title={t('officialAnalytics.funnel.title')}>
        {rows.map((m) => (
          <Card key={m.month} pad={12} style={{ marginBottom: 8 }}>
            <T weight="600" style={{ marginBottom: 6 }}>{m.month}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {m.accepted > 0 && <T size={12} color={c.positive}>{t('officialAnalytics.funnel.accepted')}: {m.accepted}</T>}
              {m.declined > 0 && <T size={12} color={c.danger}>{t('officialAnalytics.funnel.declined')}: {m.declined}</T>}
              {m.cancelled > 0 && <T size={12} color={c.warn}>{t('officialAnalytics.funnel.cancelled')}: {m.cancelled}</T>}
              {m.completed > 0 && <T size={12} color={c.info}>{t('officialAnalytics.funnel.completed')}: {m.completed}</T>}
            </View>
          </Card>
        ))}
      </Section>
      {data.data?.totals && (
        <Section title={t('officialAnalytics.funnel.totals')}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <StatPill value={String(data.data.totals.accepted ?? 0)} label={t('officialAnalytics.funnel.accepted')} color={c.positive} />
            <StatPill value={String(data.data.totals.declined ?? 0)} label={t('officialAnalytics.funnel.declined')} color={c.danger} />
            <StatPill value={String(data.data.totals.cancelled ?? 0)} label={t('officialAnalytics.funnel.cancelled')} color={c.warn} />
            <StatPill value={String(data.data.totals.completed ?? 0)} label={t('officialAnalytics.funnel.completed')} color={c.info} />
          </View>
        </Section>
      )}
    </ScrollView>
  );
}

// ── Sport & Role ───────────────────────────────────────────────────────────

function SportRoleTab({ from, to }) {
  const params = from && to ? { from, to } : {};
  const data = useLoad(() => api.get('/me/officials/analytics/sport-breakdown', params), [from, to]);

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const rows = data.data?.breakdown ?? [];

  if (!rows.length) {
    return <Empty icon="🏅" title={t('officialAnalytics.sportBreakdown.empty')} />;
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      <Section title={t('officialAnalytics.sportBreakdown.title')}>
        {rows.map((r, i) => (
          <Card key={i} pad={12} style={{ marginBottom: 8 }}>
            <T weight="600" size={14}>{r.sport_emoji ?? ''} {r.sport_name ?? r.sport_id}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
              {r.role && <T size={12} color={c.info}>{t('officialAnalytics.sportBreakdown.role')}: {r.role}</T>}
              {r.level && <T size={12} color={c.violet}>{t('officialAnalytics.sportBreakdown.level')}: {r.level}</T>}
              <T size={12}>{t('officialAnalytics.sportBreakdown.games')}: {r.games ?? 0}</T>
              <T size={12}>{t('officialAnalytics.sportBreakdown.hours')}: {Number(r.hours ?? 0).toFixed(1)}h</T>
              {r.avg_fee_minor != null && (
                <T size={12} color={c.positive}>
                  {t('officialAnalytics.sportBreakdown.avgFee')}: {(r.avg_fee_minor / 100).toFixed(2)} {r.fee_currency ?? ''}
                </T>
              )}
            </View>
          </Card>
        ))}
      </Section>
    </ScrollView>
  );
}

// ── Utilisation ────────────────────────────────────────────────────────────

function UtilisationTab({ from, to }) {
  const params = from && to ? { from, to } : { months: 24 };
  const data = useLoad(() => api.get('/me/officials/analytics/utilisation', params), [from, to]);

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const rows = data.data?.monthly ?? [];

  if (!rows.length) {
    return <Empty icon="📅" title={t('officialAnalytics.utilisation.empty')} />;
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      <Section title={t('officialAnalytics.utilisation.title')}>
        {rows.map((m) => (
          <Card key={m.month} pad={12} style={{ marginBottom: 6 }}>
            <Row
              label={m.month}
              right={m.utilisation_pct != null ? `${m.utilisation_pct}%` : '—'}
            />
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 4 }}>
              <T size={12} color={c.mute}>{t('officialAnalytics.utilisation.available')}: {m.available_slots ?? '—'}</T>
              <T size={12} color={c.info}>{t('officialAnalytics.utilisation.filled')}: {m.filled_slots ?? '—'}</T>
            </View>
          </Card>
        ))}
      </Section>
    </ScrollView>
  );
}

// ── Repeat Clients ─────────────────────────────────────────────────────────

function ClientsTab({ from, to }) {
  const params = from && to ? { from, to } : {};
  const data = useLoad(() => api.get('/me/officials/analytics/repeat-clients', params), [from, to]);

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const clients = data.data?.clients ?? [];

  if (!clients.length) {
    return <Empty icon="🏢" title={t('officialAnalytics.clients.empty')} />;
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      <Section title={t('officialAnalytics.clients.title')}>
        {clients.map((c_, i) => (
          <Row
            key={c_.org_id}
            label={`${i + 1}. ${c_.org_name ?? c_.org_id}`}
            right={`${c_.game_count} ${t('officialAnalytics.clients.games')}`}
          />
        ))}
      </Section>
    </ScrollView>
  );
}

// ── Accreditation ──────────────────────────────────────────────────────────

const GRADE_COLOR = { green: c.positive, amber: c.warn, red: c.danger };

function AccreditationTab() {
  const data = useLoad(() => api.get('/me/officials/analytics/accreditation', {}), []);

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const sports = data.data?.sports ?? [];

  if (!sports.length) {
    return <Empty icon="🎓" title={t('officialAnalytics.accreditation.empty')} />;
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      <Section title={t('officialAnalytics.accreditation.title')}>
        {sports.map((s) => (
          <Card key={s.sport_id} pad={12} style={{ marginBottom: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <T weight="600">{s.sport_emoji ?? ''} {s.sport_name ?? s.sport_id}</T>
              {s.status && (
                <View style={{ backgroundColor: GRADE_COLOR[s.status] ?? c.mute, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 }}>
                  <T size={11} color="#fff">{s.status.toUpperCase()}</T>
                </View>
              )}
            </View>
            <View style={{ marginTop: 8, gap: 4 }}>
              <Row label={t('officialAnalytics.accreditation.currentLevel')} right={s.current_level ?? '—'} />
              <Row label={t('officialAnalytics.accreditation.targetLevel')} right={s.target_level ?? '—'} />
              {s.games_needed != null && (
                <Row label={t('officialAnalytics.accreditation.gamesNeeded')} right={String(s.games_needed)} />
              )}
              {s.observations_needed != null && (
                <Row label={t('officialAnalytics.accreditation.observationsNeeded')} right={String(s.observations_needed)} />
              )}
            </View>
          </Card>
        ))}
      </Section>
    </ScrollView>
  );
}

// ── Incidents ──────────────────────────────────────────────────────────────

function IncidentsTab({ from, to }) {
  const params = from && to ? { from, to } : { months: 24 };
  const data = useLoad(() => api.get('/me/officials/analytics/incidents', params), [from, to]);

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;

  const rows = data.data?.monthly ?? [];

  return (
    <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
      <Card pad={12} style={{ backgroundColor: c.infoSoft ?? c.mute, marginHorizontal: 0 }}>
        <T size={12} color={c.info}>{t('officialAnalytics.incidents.disclaimer')}</T>
      </Card>
      {rows.length === 0
        ? <Empty icon="🛡️" title={t('officialAnalytics.incidents.empty')} />
        : (
          <Section title={t('officialAnalytics.incidents.title')}>
            {rows.map((m) => (
              <Row key={m.month} label={m.month} right={`${m.count ?? 0} ${t('officialAnalytics.incidents.count')}`} />
            ))}
          </Section>
        )
      }
    </ScrollView>
  );
}

// ── Root screen ────────────────────────────────────────────────────────────

export default function OfficialAnalyticsScreen() {
  const [tab, setTab] = useState('overview');
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);

  const showDateFilter = ['overview', 'funnel', 'sportRole', 'utilisation', 'clients', 'incidents'].includes(tab);

  return (
    <Screen title={t('officialAnalytics.title')}>
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
        {tab === 'overview'      && <OverviewTab from={from} to={to} />}
        {tab === 'funnel'        && <FunnelTab from={from} to={to} />}
        {tab === 'sportRole'     && <SportRoleTab from={from} to={to} />}
        {tab === 'utilisation'   && <UtilisationTab from={from} to={to} />}
        {tab === 'clients'       && <ClientsTab from={from} to={to} />}
        {tab === 'accreditation' && <AccreditationTab />}
        {tab === 'incidents'     && <IncidentsTab from={from} to={to} />}
      </View>
    </Screen>
  );
}
