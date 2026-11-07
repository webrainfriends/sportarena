// PS-06: Public read-only accessibility tab for venue detail. No edit controls.
import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { explain, LoadError } from '../access';
import { Loading, T } from '../ui';
import { c, r } from '../theme';

const FEATURE_EMOJI = {
  step_free_route: '♿', lift: '🛗', accessible_changing: '🚿', accessible_toilet: '🚻',
  accessible_parking: '🅿️', pool_hoist: '🏊', tactile_markings: '👁', hearing_loop: '🔊',
  quiet_room: '🤫', wheelchair_circulation: '🔄', accessible_viewing: '👀',
  accessible_emergency_egress: '🚨', accessible_drop_off: '🚐',
};

const STATE_COLOR = { certified: c.lime, third_party: c.cyan, self_reported: c.sun, provisional: c.mute, unknown: c.mute, expired: c.red };
const STATE_BG = { certified: c.limeSoft, third_party: c.cyanSoft, self_reported: c.sunSoft, provisional: c.bg, unknown: c.bg, expired: c.redSoft };

export function VenueAccessPublic({ venueId }) {
  const data = useLoad(() => api.get(`/venues/${venueId}/access-features`), [venueId]);

  if (data.error) return <LoadError error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;

  const features = data.data.features;
  const certified = features.filter((f) => f.state === 'certified').length;
  const thirdParty = features.filter((f) => f.state === 'third_party').length;
  const selfReported = features.filter((f) => f.state === 'self_reported').length;
  const hasOutage = features.some((f) => f.outage_active);
  const recorded = features.filter((f) => !['unknown'].includes(f.state)).length;

  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 12 }}>
      <T size={17} weight="800">{t('acc.public.title')}</T>

      {/* KPI strip */}
      <View style={ss.kpiRow}>
        {certified > 0 && (
          <View style={[ss.kpi, { backgroundColor: c.limeSoft }]}>
            <T size={20} weight="800" color={c.lime}>{certified}</T>
            <T size={10} weight="700" color={c.lime} style={ss.kpiLabel}>{t('acc.state.certified')}</T>
          </View>
        )}
        {thirdParty > 0 && (
          <View style={[ss.kpi, { backgroundColor: c.cyanSoft }]}>
            <T size={20} weight="800" color={c.cyan}>{thirdParty}</T>
            <T size={10} weight="700" color={c.cyan} style={ss.kpiLabel}>{t('acc.state.third_party')}</T>
          </View>
        )}
        {selfReported > 0 && (
          <View style={[ss.kpi, { backgroundColor: c.sunSoft }]}>
            <T size={20} weight="800" color={c.sun}>{selfReported}</T>
            <T size={10} weight="700" color={c.sun} style={ss.kpiLabel}>{t('acc.state.self_reported')}</T>
          </View>
        )}
        <View style={[ss.kpi, { backgroundColor: c.bg }]}>
          <T size={20} weight="800" color={c.ink}>{recorded}</T>
          <T size={10} weight="700" color={c.mute} style={ss.kpiLabel}>recorded / {features.length}</T>
        </View>
      </View>

      {/* Active outage banner */}
      {hasOutage && (
        <View style={[ss.banner, { borderColor: c.sun, backgroundColor: c.sunSoft }]}>
          <T size={13} weight="800" color={c.sun}>
            ⚠ {features.filter((f) => f.outage_active).map((f) => t(`acc.feat.${f.feature}`)).join(', ')} — {t('acc.outage.active')}
          </T>
        </View>
      )}

      {/* Feature list */}
      {features.map((feat) => {
        const color = STATE_COLOR[feat.state] ?? c.mute;
        const bg = STATE_BG[feat.state] ?? c.bg;
        return (
          <View key={feat.feature} style={[ss.row, feat.state === 'unknown' && ss.rowUnknown, feat.outage_active && ss.rowOutage]}>
            <T size={20} style={{ marginInlineEnd: 10 }}>{FEATURE_EMOJI[feat.feature] ?? '♿'}</T>
            <View style={{ flex: 1 }}>
              <T size={14} weight="700" color={feat.state === 'unknown' ? c.mute : c.ink}>{t(`acc.feat.${feat.feature}`)}</T>
              {feat.last_checked && feat.state !== 'unknown' && (
                <T size={11} color={c.mute}>{t('acc.checked')}: {feat.last_checked}</T>
              )}
              {feat.outage_active && (
                <T size={11} weight="700" color={c.sun}>⚠ {t('acc.outage.active')}{feat.outage_reason ? ` — ${feat.outage_reason}` : ''}</T>
              )}
              {feat.expires_at && !feat.outage_active && new Date(feat.expires_at) < new Date(Date.now() + 90 * 864e5) && (
                <T size={11} color={c.sun}>⚠ {t('acc.expires')}: {feat.expires_at}</T>
              )}
            </View>
            <View style={[ss.chip, { backgroundColor: bg }]}>
              <T size={11} weight="700" color={color}>{t(`acc.state.${feat.state}`)}</T>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

const ss = StyleSheet.create({
  kpiRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  kpi: { flex: 1, minWidth: 60, borderRadius: r.input, padding: 10 },
  kpiLabel: { textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2 },
  banner: { borderWidth: 1.5, borderRadius: r.input, padding: 10 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.paper, borderRadius: r.input, padding: 12, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  rowUnknown: { backgroundColor: c.bg, shadowOpacity: 0 },
  rowOutage: { borderWidth: 1.5, borderColor: c.sun },
  chip: { borderRadius: r.pill, paddingVertical: 4, paddingHorizontal: 10 },
});
