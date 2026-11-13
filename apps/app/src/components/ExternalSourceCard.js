import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { T } from '../ui';
import { t } from '../i18n';
import { c } from '../theme';

const PROVIDER_ICON = {
  event_source_ics_feed: '📅',
  event_source_federation_xml: '🏅',
  event_source_bookmyshow_in: '🎟️',
  event_source_manual: '📋',
};
const providerIcon = (key) => PROVIDER_ICON[key] ?? '🔗';

const TRUST_STYLE = {
  verified: { bg: '#8458B3', text: '#fff', label: 'event.ext.trust_verified' },
  organiser_attested: { bg: '#A0D2EB', text: '#2A2D3A', label: 'event.ext.trust_attested' },
  reference_only: { bg: '#8898AA', text: '#fff', label: 'event.ext.trust_reference' },
};
const STATUS_COLOR = { active: '#2F8F5F', stale: '#D97706', unlinked: '#8898AA', archived: '#8898AA' };

export function ExternalSourceCard({ link, onSync, onUnlink, onViewSource, isOrganiser, compact }) {
  if (!link) return null;
  const trust = TRUST_STYLE[link.trust_level] ?? TRUST_STYLE.reference_only;
  const statusColor = STATUS_COLOR[link.status] ?? '#8898AA';
  const caps = link.managed_capabilities ?? [];
  const shownCaps = caps.slice(0, 3);
  const extraCaps = caps.length - 3;

  if (compact) {
    return (
      <View style={[styles.compactRow, { backgroundColor: c.paper }]}>
        <T size={14}>{providerIcon(link.provider_key)}</T>
        <View style={[styles.trustBadge, { backgroundColor: trust.bg }]}>
          <T size={11} weight="700" color={trust.text}>{t(trust.label)}</T>
        </View>
        <T size={13} weight="600" color={c.ink} style={{ flex: 1 }} numberOfLines={1}>
          {link.origin_label ?? link.provider_key}
        </T>
        <View style={[styles.dot, { backgroundColor: statusColor }]} />
        {link.attention_required ? <T size={14}>⚠️</T> : null}
      </View>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: c.paper, borderColor: link.attention_required ? c.sun : c.line }]}>
      <View style={styles.headerRow}>
        <T size={22}>{providerIcon(link.provider_key)}</T>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={styles.row}>
            <View style={[styles.trustBadge, { backgroundColor: trust.bg }]}>
              <T size={11} weight="700" color={trust.text}>{t(trust.label)}</T>
            </View>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <T size={12} color={c.mute}>{t(`event.ext.status_${link.status}`)}</T>
          </View>
          <T size={14} weight="700" color={c.ink} numberOfLines={1}>
            {link.origin_label ?? link.provider_key}
          </T>
          <T size={12} color={c.mute}>
            {link.link_mode === 'reference_only'
              ? t('event.ext.reference_only_label')
              : link.last_sync_at
                ? `${t('event.ext.last_sync')} ${new Date(link.last_sync_at).toLocaleDateString()}`
                : t('event.ext.never_synced')}
          </T>
        </View>
      </View>

      {shownCaps.length > 0 && (
        <View style={[styles.row, { flexWrap: 'wrap', gap: 4, marginTop: 8 }]}>
          {shownCaps.map((cap) => (
            <View key={cap} style={[styles.capChip, { backgroundColor: c.pinkSoft }]}>
              <T size={11} weight="600" color={c.pink}>{cap.replace(/_/g, ' ')}</T>
            </View>
          ))}
          {extraCaps > 0 && (
            <View style={[styles.capChip, { backgroundColor: c.line }]}>
              <T size={11} weight="600" color={c.mute}>+{extraCaps} {t('event.ext.more_caps')}</T>
            </View>
          )}
        </View>
      )}

      {link.attention_required && (
        <View style={[styles.attentionBanner, { backgroundColor: c.sunSoft }]}>
          <T size={12} weight="700" color={c.sun}>
            ⚠️ {link.pending_changes > 0 ? t('event.ext.changes_pending') : t('event.ext.sync_failed')}
          </T>
        </View>
      )}

      {isOrganiser && (
        <View style={[styles.row, { gap: 8, marginTop: 10 }]}>
          {link.link_mode !== 'reference_only' && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: c.pink }]}
              onPress={onSync}
              accessibilityLabel={t('event.ext.action_sync')}>
              <T size={12} weight="700" color="#fff">{t('event.ext.action_sync')}</T>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: c.pinkSoft }]}
            onPress={onViewSource}
            accessibilityLabel={t('event.ext.action_view')}>
            <T size={12} weight="700" color={c.pink}>{t('event.ext.action_view')} ↗</T>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: c.line }]}
            onPress={onUnlink}
            accessibilityLabel={t('event.ext.action_unlink')}>
            <T size={12} weight="600" color={c.mute}>{t('event.ext.action_unlink')}</T>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, padding: 14, borderWidth: 1, marginVertical: 6 },
  compactRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 10, padding: 10, marginVertical: 4 },
  headerRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  trustBadge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  capChip: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  attentionBanner: { borderRadius: 8, padding: 8, marginTop: 8 },
  actionBtn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center', alignItems: 'center' },
});
