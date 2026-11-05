// PS-06: Event organiser operational accessibility checklist. Per-venue sections with KPI strip.
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { t } from '../i18n';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useLayout } from '../layout';
import { LoadError } from '../access';
import { Loading, T } from '../ui';
import { c, r } from '../theme';

const STATE_ICON = { met: '✓', outage: '⚠', unknown: '?', expired: '⚠' };
const STATE_COLOR = { met: c.lime, outage: c.sun, unknown: c.mute, expired: c.sun };
const STATE_BG = { met: c.limeSoft, outage: c.sunSoft, unknown: c.bg, expired: c.sunSoft };

function VenueSection({ venue }) {
  const [expanded, setExpanded] = useState(true);
  const { met, gap, unknown, outage } = venue.summary;
  const hasIssues = gap + unknown + outage > 0;

  return (
    <View style={[ss.venueCard, hasIssues && ss.venueCardAlert]}>
      <Pressable onPress={() => setExpanded((v) => !v)} style={ss.venueHeader} accessibilityRole="button" accessibilityLabel={venue.venue_name}>
        <View style={{ flex: 1 }}>
          <T size={15} weight="800">{venue.venue_name}</T>
          <View style={ss.miniKpi}>
            <T size={11} weight="700" color={c.lime}>{met} ✓</T>
            {outage > 0 && <T size={11} weight="700" color={c.sun}> {outage} ⚠</T>}
            {gap > 0 && <T size={11} weight="700" color={c.red}> {gap} ✗</T>}
            {unknown > 0 && <T size={11} weight="700" color={c.mute}> {unknown} ?</T>}
          </View>
        </View>
        <T size={16} color={c.mute}>{expanded ? '▲' : '▼'}</T>
      </Pressable>

      {expanded && (
        <View style={{ paddingTop: 8, gap: 6 }}>
          {venue.features.map((item) => {
            const color = STATE_COLOR[item.state] ?? c.mute;
            const bg = STATE_BG[item.state] ?? c.bg;
            const icon = STATE_ICON[item.state] ?? '?';
            return (
              <View key={item.feature} style={ss.featRow} accessibilityLabel={`${t(`acc.feat.${item.feature}`)}: ${t(`acc.check.${item.state}`)}`}>
                <View style={[ss.iconBox, { backgroundColor: bg }]}>
                  <T size={13} weight="800" color={color}>{icon}</T>
                </View>
                <View style={{ flex: 1, marginInlineStart: 8 }}>
                  <T size={13} weight="700">{t(`acc.feat.${item.feature}`)}</T>
                  {item.state !== 'met' && <T size={11} color={color}>{t(`acc.check.${item.state}`)}</T>}
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

export function EventAccessChecklist({ eventId }) {
  const { wide } = useLayout();
  const data = useLoad(() => api.get(`/events/${eventId}/access-checklist`), [eventId]);
  const [selectedVenueIdx, setSelectedVenueIdx] = useState(0);

  if (data.error) return <LoadError error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading />;

  const venues = data.data.venues;
  if (!venues || venues.length === 0) return (
    <View style={{ padding: 24, alignItems: 'center' }}>
      <T size={14} color={c.mute}>{t('acc.check.title')} — {t('acc.state.unknown')}</T>
    </View>
  );

  // Global KPIs
  const totalMet = venues.reduce((s, v) => s + v.summary.met, 0);
  const totalGap = venues.reduce((s, v) => s + v.summary.gap, 0);
  const totalUnknown = venues.reduce((s, v) => s + v.summary.unknown, 0);
  const totalOutage = venues.reduce((s, v) => s + v.summary.outage, 0);

  if (wide) {
    // Desktop: sidebar + detail
    const venue = venues[selectedVenueIdx];
    return (
      <View style={{ flex: 1, flexDirection: 'row' }}>
        {/* Sidebar */}
        <View style={ss.sidebar}>
          <T size={15} weight="800" style={{ padding: 14, paddingBottom: 8 }}>{t('acc.check.title')}</T>
          <View style={[ss.kpiRow, { paddingHorizontal: 14, marginBottom: 8 }]}>
            <T size={11} weight="700" color={c.lime}>{totalMet} ✓  </T>
            <T size={11} weight="700" color={c.sun}>{totalOutage} ⚠  </T>
            <T size={11} weight="700" color={c.red}>{totalGap} ✗  </T>
            <T size={11} weight="700" color={c.mute}>{totalUnknown} ?</T>
          </View>
          <ScrollView>
            {venues.map((v, i) => {
              const hasIssues = v.summary.gap + v.summary.unknown + v.summary.outage > 0;
              return (
                <Pressable key={v.venue_id} onPress={() => setSelectedVenueIdx(i)} style={[ss.sidebarRow, i === selectedVenueIdx && ss.sidebarRowActive]} accessibilityRole="button" accessibilityLabel={v.venue_name}>
                  <T size={13} weight={i === selectedVenueIdx ? '800' : '500'} color={i === selectedVenueIdx ? c.pink : c.ink}>{v.venue_name}</T>
                  {hasIssues && <T size={11} weight="700" color={c.sun}>⚠</T>}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
        {/* Main */}
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
          {venue && <VenueSection venue={venue} />}
        </ScrollView>
      </View>
    );
  }

  // Phone: flat list
  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
      <T size={17} weight="800">{t('acc.check.title')}</T>
      <View style={ss.kpiRow}>
        <View style={[ss.kpi, { backgroundColor: c.limeSoft }]}><T size={18} weight="800" color={c.lime}>{totalMet}</T><T size={10} weight="700" color={c.lime} style={ss.kpiLabel}>{t('acc.check.met')}</T></View>
        <View style={[ss.kpi, { backgroundColor: c.sunSoft }]}><T size={18} weight="800" color={c.sun}>{totalOutage}</T><T size={10} weight="700" color={c.sun} style={ss.kpiLabel}>{t('acc.check.outage')}</T></View>
        <View style={[ss.kpi, { backgroundColor: c.bg }]}><T size={18} weight="800" color={c.mute}>{totalUnknown}</T><T size={10} weight="700" color={c.mute} style={ss.kpiLabel}>{t('acc.check.unknown')}</T></View>
      </View>
      {venues.map((v) => <VenueSection key={v.venue_id} venue={v} />)}
    </ScrollView>
  );
}

const ss = StyleSheet.create({
  kpiRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  kpi: { flex: 1, minWidth: 60, borderRadius: r.input, padding: 10 },
  kpiLabel: { textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 2 },
  venueCard: { backgroundColor: c.paper, borderRadius: r.card, padding: 13, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  venueCardAlert: { borderWidth: 1.5, borderColor: c.sun },
  venueHeader: { flexDirection: 'row', alignItems: 'center' },
  miniKpi: { flexDirection: 'row', marginTop: 2 },
  featRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  iconBox: { width: 28, height: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  sidebar: { width: 220, borderInlineEndWidth: 1, borderColor: c.line, backgroundColor: c.paper },
  sidebarRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderColor: c.line },
  sidebarRowActive: { backgroundColor: c.bg },
});
