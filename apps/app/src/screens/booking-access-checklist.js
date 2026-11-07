// PS-06: Non-blocking booking suitability checklist. Shown on booking detail for accessible needs.
import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { LoadError } from '../access';
import { Loading, T } from '../ui';
import { c, r } from '../theme';

const STATE_ICON = { met: '✓', outage: '⚠', unknown: '?', expired: '⚠' };
const STATE_COLOR = { met: c.lime, outage: c.sun, unknown: c.mute, expired: c.sun };
const STATE_BG = { met: c.limeSoft, outage: c.sunSoft, unknown: c.bg, expired: c.sunSoft };

export function BookingAccessChecklist({ bookingId }) {
  const data = useLoad(() => api.get(`/bookings/${bookingId}/access-suitability`), [bookingId]);

  if (data.error) return <LoadError error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;

  const { items } = data.data;
  if (!items || items.length === 0) return null;

  const attention = items.filter((i) => i.state !== 'met').length;
  const allMet = attention === 0;

  return (
    <View style={ss.container}>
      <T size={15} weight="800" style={{ marginBottom: 10 }}>{t('acc.check.title')}</T>

      {/* Summary banner */}
      <View style={[ss.banner, { borderColor: allMet ? c.lime : c.sun, backgroundColor: allMet ? c.limeSoft : c.sunSoft }]}>
        <T size={13} weight="800" color={allMet ? c.lime : c.sun}>
          {allMet ? t('acc.check.all_met') : `${attention} ${t('acc.check.needs_attention')}`}
        </T>
      </View>

      {items.map((item) => {
        const color = STATE_COLOR[item.state] ?? c.mute;
        const bg = STATE_BG[item.state] ?? c.bg;
        const icon = STATE_ICON[item.state] ?? '?';
        return (
          <View key={item.feature} style={ss.row} accessibilityLabel={`${t(`acc.feat.${item.feature}`)}: ${t(`acc.check.${item.state}`)}`}>
            <View style={[ss.iconBox, { backgroundColor: bg }]}>
              <T size={15} weight="800" color={color}>{icon}</T>
            </View>
            <View style={{ flex: 1, marginInlineStart: 10 }}>
              <T size={14} weight="700">{t(`acc.feat.${item.feature}`)}</T>
              <T size={12} color={color}>{t(`acc.check.${item.state}`)}</T>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const ss = StyleSheet.create({
  container: { padding: 14, gap: 8 },
  banner: { borderWidth: 1.5, borderRadius: r.input, padding: 10, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.paper, borderRadius: r.input, padding: 12, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  iconBox: { width: 32, height: 32, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
});
