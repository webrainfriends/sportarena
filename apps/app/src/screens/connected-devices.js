// Connected devices & activity synchronisation (#327). Lists wearable/health integrations, connects/disconnects, shows 7-day history,
// manual import. OAuth tokens are stored server-side encrypted; this screen never receives or displays token values.
import React, { useState, useCallback } from 'react';
import { View, ScrollView, TouchableOpacity, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useLayout } from '../layout';
import { Btn, Card, T } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';

const PROVIDERS = [
  { id: 'garmin',       name: 'Garmin',       icon: '⌚', metrics: 'HR · HRV · Power · Sleep · GPS' },
  { id: 'apple_health', name: 'Apple Health', icon: '🍎', metrics: 'HealthKit — all metrics' },
  { id: 'google_fit',   name: 'Google Fit',   icon: '🟢', metrics: 'Steps · HR · Activities' },
  { id: 'whoop',        name: 'Whoop',        icon: '🔵', metrics: 'HRV · Recovery · Strain' },
  { id: 'polar',        name: 'Polar',        icon: '🔴', metrics: 'HR · Power · Run metrics' },
  { id: 'fitbit',       name: 'Fitbit',       icon: '🟡', metrics: 'Steps · Sleep · HR' },
  { id: 'suunto',       name: 'Suunto',       icon: '🔺', metrics: 'Training load · GPS' },
];

const ACTIVITY_ICONS = { run: '🏃', cycle: '🚴', swim: '🏊', strength: '🏋️', sleep: '🌙', other: '⚡' };

function ProviderIcon({ id }) {
  return <T size={22}>{PROVIDERS.find((p) => p.id === id)?.icon || '📱'}</T>;
}

function StatusChip({ status }) {
  const color = { active: c.lime, paused: c.sun, error: c.red, unlinked: c.mute }[status] ?? c.mute;
  return (
    <View style={[styles.statusChip, { backgroundColor: color + '22', borderColor: color }]}>
      <T size={10} style={{ color, fontWeight: '700' }}>{t(`cd.status.${status}`)}</T>
    </View>
  );
}

function DeviceRow({ device, onPress }) {
  return (
    <TouchableOpacity
      style={[styles.deviceRow, { borderBottomColor: c.line }]}
      onPress={() => onPress(device)}
      accessibilityRole="button"
      accessibilityLabel={device.display_name || device.provider}
    >
      <View style={[styles.deviceIcon, { backgroundColor: c.bg }]}>
        <ProviderIcon id={device.provider} />
      </View>
      <View style={{ flex: 1 }}>
        <T weight="700" size={14}>{device.display_name || device.provider}</T>
        <T size={12} color={c.mute}>
          {device.last_sync_at
            ? `${t('cd.last_sync')}: ${new Date(device.last_sync_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : t('cd.never_synced')}
          {device.battery_pct != null ? ` · 🔋 ${device.battery_pct}%` : ''}
        </T>
      </View>
      <StatusChip status={device.status} />
    </TouchableOpacity>
  );
}

function ConnectSheet({ connected, onDone, onClose }) {
  const [connecting, setConnecting] = useState(null);

  const handleConnect = useCallback(async (provider) => {
    setConnecting(provider.id);
    try {
      await api.post('/me/devices', { provider: provider.id, display_name: provider.name });
      onDone();
    } catch (_e) { /* handled by api layer */ }
    finally { setConnecting(null); }
  }, [onDone]);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <T weight="800" size={18} style={{ marginBottom: 6 }}>{t('cd.connect')}</T>
      <T size={13} color={c.mute} style={{ marginBottom: 20, lineHeight: 18 }}>
        Your data stays private — only you and coaches you explicitly share with can see synced metrics.
      </T>
      <View style={styles.providerGrid}>
        {PROVIDERS.map((p) => {
          const isConnected = connected.includes(p.id);
          return (
            <TouchableOpacity
              key={p.id}
              style={[
                styles.providerTile,
                { borderColor: isConnected ? c.lime : c.line, backgroundColor: c.paper },
                isConnected && { borderWidth: 2 },
              ]}
              onPress={() => !isConnected && handleConnect(p)}
              disabled={isConnected || connecting === p.id}
              accessibilityRole="button"
              accessibilityLabel={`${t('cd.connect')} ${p.name}`}
            >
              <T size={28}>{p.icon}</T>
              <T weight="700" size={13} style={{ textAlign: 'center' }}>{p.name}</T>
              <T size={10} color={c.mute} style={{ textAlign: 'center' }}>{p.metrics}</T>
              {connecting === p.id
                ? <ActivityIndicator color={c.pink} />
                : isConnected
                  ? <StatusChip status="active" />
                  : <View style={[styles.connectBadge, { backgroundColor: c.pink }]}>
                      <T size={10} style={{ color: '#fff', fontWeight: '700' }}>{t('cd.connect')}</T>
                    </View>
              }
            </TouchableOpacity>
          );
        })}
      </View>
      <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityRole="button">
        <T size={14} color={c.mute} style={{ fontWeight: '600', textAlign: 'center' }}>Close</T>
      </TouchableOpacity>
    </ScrollView>
  );
}

function DeviceDetail({ device, onBack, onDisconnected }) {
  const [pausing, setPausing] = useState(false);
  const history = useLoad(() => api.get(`/me/devices/${device.id}/history`, { days: 7 }), [device.id]);

  const handlePause = useCallback(async () => {
    setPausing(true);
    try {
      await api.patch(`/me/devices/${device.id}`, { paused: device.status !== 'paused' });
      onBack();
    } finally { setPausing(false); }
  }, [device, onBack]);

  const handleDisconnect = useCallback(async () => {
    await api.delete(`/me/devices/${device.id}`);
    onDisconnected();
  }, [device, onDisconnected]);

  const provider = PROVIDERS.find((p) => p.id === device.provider);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 32 }}>
      <TouchableOpacity onPress={onBack} style={styles.backRow} accessibilityRole="button">
        <T size={15} style={{ color: c.pink, fontWeight: '600' }}>‹ {t('cd.title')}</T>
      </TouchableOpacity>

      <View style={[styles.deviceHeader, { backgroundColor: c.paper }]}>
        <T size={22} style={{ marginBottom: 4 }}>{provider?.icon} {device.display_name}</T>
        <T size={13} color={c.mute}>
          {device.last_sync_at
            ? `Last synced ${new Date(device.last_sync_at).toLocaleString()}`
            : 'Never synced'}
          {device.battery_pct != null ? ` · 🔋 ${device.battery_pct}%` : ''}
        </T>
        <StatusChip status={device.status} />
        <View style={styles.deviceActions}>
          <Btn
            title={device.status === 'paused' ? t('cd.resume') : t('cd.pause')}
            small
            color={c.paper}
            ink={c.ink}
            onPress={handlePause}
            loading={pausing}
          />
          <Btn title={t('cd.disconnect')} small color="#E11D48" ink="#fff" onPress={handleDisconnect} />
        </View>
      </View>

      <T weight="800" size={15} style={styles.sectionTitle}>{t('cd.sync_history')} (7 days)</T>
      {history.loading && <ActivityIndicator color={c.pink} style={{ margin: 16 }} />}

      {!history.loading && (history.data?.activities || []).length === 0 && (
        <Card pad={16} style={{ marginHorizontal: 16 }}>
          <T size={13} color={c.mute} style={{ textAlign: 'center' }}>{t('cd.empty')}</T>
        </Card>
      )}

      {(history.data?.activities || []).map((act) => (
        <View key={act.id} style={[styles.actRow, { backgroundColor: c.paper, borderColor: c.line }]}>
          <T size={22} style={{ width: 36, textAlign: 'center' }}>{ACTIVITY_ICONS[act.activity_type] || '⚡'}</T>
          <View style={{ flex: 1 }}>
            <T weight="700" size={14} style={{ textTransform: 'capitalize' }}>{act.activity_type}</T>
            <T size={12} color={c.mute}>
              {new Date(act.started_at).toLocaleDateString()} · {act.source}
            </T>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

export function ConnectedDevicesScreen() {
  const [showConnect, setShowConnect] = useState(false);
  const [selected, setSelected] = useState(null);
  const { tablet } = useLayout();

  const devices = useLoad(() => api.get('/me/devices'), []);
  const connectedProviders = (devices.data || []).map((d) => d.provider);

  if (selected) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <DeviceDetail
          device={selected}
          onBack={() => { setSelected(null); devices.reload(); }}
          onDisconnected={() => { setSelected(null); devices.reload(); }}
        />
      </View>
    );
  }

  if (showConnect) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <ConnectSheet
          connected={connectedProviders}
          onDone={() => { setShowConnect(false); devices.reload(); }}
          onClose={() => setShowConnect(false)}
        />
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {/* Connect CTA */}
        <TouchableOpacity
          style={[styles.connectCta, { backgroundColor: c.paper, borderColor: c.line }]}
          onPress={() => setShowConnect(true)}
          accessibilityRole="button"
          accessibilityLabel={t('cd.connect')}
        >
          <T size={28}>📡</T>
          <View style={{ flex: 1 }}>
            <T weight="700" size={14}>{t('cd.connect')}</T>
            <T size={12} color={c.mute}>Garmin · Apple Health · Whoop · Polar · Google Fit…</T>
          </View>
          <T size={22} color={c.mute}>›</T>
        </TouchableOpacity>

        {devices.loading && <ActivityIndicator color={c.pink} style={{ margin: 24 }} />}

        {!devices.loading && (devices.data || []).length > 0 && (
          <>
            <T weight="800" size={15} style={styles.sectionTitle}>{t('cd.title')}</T>
            <View style={[styles.card, { backgroundColor: c.paper }]}>
              {(devices.data || []).map((d) => (
                <DeviceRow key={d.id} device={d} onPress={setSelected} />
              ))}
            </View>
          </>
        )}

        {!devices.loading && (devices.data || []).length === 0 && (
          <View style={{ padding: 32, alignItems: 'center' }}>
            <T size={36}>📡</T>
            <T size={14} color={c.mute} style={{ marginTop: 8, textAlign: 'center' }}>{t('cd.empty')}</T>
          </View>
        )}

        {/* Manual import */}
        <T weight="800" size={15} style={styles.sectionTitle}>{t('cd.import_activity')}</T>
        <View style={[styles.importBox, { borderColor: c.line, backgroundColor: c.paper }]}>
          <T size={28}>📁</T>
          <View style={{ flex: 1 }}>
            <T weight="700" size={13}>Drop a .FIT, .GPX or .TCX file</T>
            <T size={11} color={c.mute}>Activities from Strava, Suunto, Polar Flow</T>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  sectionTitle: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  card: {
    marginHorizontal: 16, borderRadius: 18, overflow: 'hidden',
    ...Platform.select({ ios: { shadowColor: '#000', shadowOpacity: .07, shadowRadius: 8, shadowOffset: { height: 2, width: 0 } }, android: { elevation: 2 }, default: {} }),
  },
  deviceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  deviceIcon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  statusChip: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 3, alignSelf: 'flex-start' },
  connectCta: { flexDirection: 'row', alignItems: 'center', gap: 12, margin: 16, padding: 16, borderRadius: 18, borderWidth: 1 },
  providerGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  providerTile: { width: '47%', borderRadius: 14, padding: 14, borderWidth: 1, alignItems: 'center', gap: 6 },
  connectBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  closeBtn: { marginTop: 20, padding: 12 },
  backRow: { padding: 16 },
  deviceHeader: { margin: 16, borderRadius: 18, padding: 16, gap: 6 },
  deviceActions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  actRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 14, borderWidth: 1 },
  importBox: { flexDirection: 'row', alignItems: 'center', gap: 12, margin: 16, padding: 16, borderRadius: 18, borderWidth: 2, borderStyle: 'dashed' },
});
