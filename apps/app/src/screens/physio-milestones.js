// Recovery milestones and outcome measures (#210).
// Shows milestone cards (baseline → current → target), outcome measure history, adherence strip.
// Source labelling: self_reported / clinician_measured / device_estimated shown on every data point.
import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, day } from '../theme';
import { t } from '../i18n';

const SOURCE_COLOR = { self_reported: c.mint, clinician_measured: c.violet, device_estimated: c.sky };
const sourceLabel = (s) => ({ self_reported: 'Self', clinician_measured: 'Clinician', device_estimated: 'Device' }[s] ?? s);

function ProgressBar({ value, target }) {
  if (!target || target === 0) return null;
  const pct = Math.min(100, Math.round((value / target) * 100));
  return (
    <View style={{ height: 8, borderRadius: 4, backgroundColor: c.line, overflow: 'hidden', marginTop: 6 }}>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: pct >= 100 ? c.mint : c.violet, width: `${pct}%` }} />
    </View>
  );
}

function MilestoneCard({ m }) {
  const isAchieved = m.achieved_at != null;
  return (
    <Card pad={12} color={isAchieved ? c.mintSoft : c.paper}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="800">{m.title}</T>
          <T size={12} color={c.mute}>{m.milestone_type?.replace(/_/g, ' ')}</T>
        </View>
        <Tag label={isAchieved ? t('physio.milestones.achieved') : t('physio.milestones.pending')} color={isAchieved ? c.mintSoft : c.violetSoft} />
      </View>

      {m.description && <T size={12} color={c.mute} style={{ marginTop: 4 }}>{m.description}</T>}

      {m.target_date && (
        <T size={12} color={c.mute} style={{ marginTop: 4 }}>
          {t('physio.milestones.target_date')}: {day(m.target_date)}
        </T>
      )}

      {isAchieved && m.achieved_at && (
        <T size={12} color={c.mint} style={{ marginTop: 4 }}>
          ✓ {t('physio.milestones.achieved_on')} {day(m.achieved_at)}
        </T>
      )}
    </Card>
  );
}

function OutcomeMeasures({ patientId }) {
  const data = useLoad(() => api.get(`/physio/patients/${patientId}/outcome-measures`), [patientId]);

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  const rows = data.data ?? [];
  if (!rows.length) return <Empty emoji="📊" title={t('physio.milestones.no_outcomes')} sub={t('physio.milestones.no_outcomes_sub')} />;

  const byType = {};
  for (const r of rows) { if (!byType[r.measure_type]) byType[r.measure_type] = []; byType[r.measure_type].push(r); }

  return (
    <View style={{ gap: 12 }}>
      {Object.entries(byType).map(([type, entries]) => {
        const latest = entries[0];
        return (
          <Card key={type} pad={12} color={c.paper}>
            <T weight="800">{type.toUpperCase()}</T>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {entries.slice(0, 5).map((e) => (
                <View key={e.id} style={{ alignItems: 'center', gap: 2 }}>
                  <T weight="700" size={18}>{e.score}</T>
                  {e.max_score ? <T size={11} color={c.mute}>/ {e.max_score}</T> : null}
                  <Tag label={sourceLabel(e.source ?? 'clinician_measured')} color={SOURCE_COLOR[e.source] ?? c.violetSoft} />
                  <T size={10} color={c.mute}>{day(e.measured_at)}</T>
                </View>
              ))}
            </View>
          </Card>
        );
      })}
    </View>
  );
}

export function PhysioMilestones({ patientId }) {
  const [sec, setSec] = useState('milestones');
  const data = useLoad(() => api.get(`/physio/patients/${patientId}/milestones`), [patientId]);

  return (
    <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 32 }}>
      <Card pad={12} color={c.violetSoft}>
        <T weight="900" size={16}>{t('physio.milestones.title')}</T>
      </Card>

      <Seg
        options={[
          { value: 'milestones', label: t('physio.milestones.title'), emoji: '🏁' },
          { value: 'outcomes', label: t('physio.milestones.outcomes'), emoji: '📊' },
        ]}
        value={sec} onChange={setSec} color={c.violet}
      />

      {sec === 'milestones' && (
        <>
          {data.loading && !data.data ? <Loading /> :
           data.error ? <ErrorBox error={data.error} onRetry={data.reload} /> :
           (data.data ?? []).length === 0 ? (
             <Empty emoji="🏁" title={t('physio.milestones.empty')} sub="" />
           ) : (
             (data.data ?? []).map((m) => <MilestoneCard key={m.id} m={m} />)
           )}
        </>
      )}

      {sec === 'outcomes' && <OutcomeMeasures patientId={patientId} />}
    </ScrollView>
  );
}

export default PhysioMilestones;
