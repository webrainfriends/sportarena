// Referee offline sync detail screen (R08): status, conflicts, op history, devices, pack health.
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, View, RefreshControl, Platform } from 'react-native';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Card, Section, T, Tag, Btn, Screen } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';
import { api } from '../api';
import { refereeQueue } from '../referee-queue';

const fmt = (iso) => iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

const STATUS_COLOR = { synced: c.mintSoft, conflict: c.sunSoft, failed: c.red, open: c.violetSoft, syncing: c.pinkSoft, no_session: c.line };
const STATUS_LABEL = { synced: 'Synced', conflict: 'Conflicts', failed: 'Failed', open: 'Not yet synced', syncing: 'Syncing…', no_session: 'No session' };
const OP_COLOR = { applied: c.mintSoft, duplicate: c.line, conflict: c.sunSoft, rejected: c.red, error: c.red, queued: c.pinkSoft };

function getDeviceId() {
  if (Platform.OS !== 'web') return '';
  try { return (typeof localStorage !== 'undefined' && localStorage.getItem('sa_device_id')) ?? ''; } catch { return ''; }
}

export function RefereeOfflineSync({ route }) {
  const { fixtureId } = route?.params ?? {};
  const { toast } = useSession();
  const { back } = useNav();
  const [status, setStatus] = useState(null);
  const [conflicts, setConflicts] = useState([]);
  const [history, setHistory] = useState([]);
  const [local, setLocal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const deviceId = getDeviceId();

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [sRes, cRes, hRes, lq] = await Promise.all([
        fixtureId ? api.get(`/fixtures/${fixtureId}/referee-sync/status?device_id=${encodeURIComponent(deviceId)}`).then((r) => r.data).catch(() => null) : Promise.resolve(null),
        fixtureId ? api.get(`/fixtures/${fixtureId}/referee-sync/conflicts?device_id=${encodeURIComponent(deviceId)}`).then((r) => r.data?.conflicts ?? []).catch(() => []) : Promise.resolve([]),
        fixtureId ? api.get(`/fixtures/${fixtureId}/referee-sync/history?limit=50`).then((r) => r.data?.ops ?? []).catch(() => []) : Promise.resolve([]),
        refereeQueue.getStatus(fixtureId),
      ]);
      setStatus(sRes);
      setConflicts(cRes);
      setHistory(hRes);
      setLocal(lq);
    } finally { setRefreshing(false); }
  }, [fixtureId, deviceId]);

  useEffect(() => {
    load();
    const unsub = refereeQueue.subscribe(load);
    return unsub;
  }, [load]);

  const forceSync = useCallback(async () => {
    setBusy(true);
    try { await refereeQueue.flush(fixtureId); await load(); toast(t('rof.sync_triggered')); }
    catch (e) { toast(e?.message ?? t('rof.sync_error')); }
    finally { setBusy(false); }
  }, [fixtureId, load, toast]);

  const resolve = useCallback(async (opId, resolution) => {
    setBusy(true);
    try {
      await api.post(`/referee-sync/ops/${opId}/resolve`, { resolution });
      toast(resolution === 'accept' ? t('rof.conflict_accepted') : t('rof.conflict_discarded'));
      await load();
    } catch { toast(t('rof.resolve_error')); }
    finally { setBusy(false); }
  }, [load, toast]);

  const isOffline = local?.online === false;

  return (
    <Screen title={t('rof.sync_screen_title')} back={back} accessibilityLabel={t('rof.sync_screen_title')}>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 14 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
      >
        {/* Sync status header */}
        <Card pad={16}>
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <Tag label={isOffline ? t('rof.offline') : t('rof.online')} color={isOffline ? c.sunSoft : c.mintSoft} />
              {status && <Tag label={STATUS_LABEL[status.status] ?? status.status} color={STATUS_COLOR[status.status] ?? c.line} />}
              {status?.clock_drift_ms != null && Math.abs(status.clock_drift_ms) > 5000 && (
                <Tag label={`${t('rof.clock_drift')} ${(status.clock_drift_ms / 1000).toFixed(1)}s`} color={c.sunSoft} />
              )}
            </View>
            <T weight="700" size={17}>{t('rof.sync_screen_title')}</T>
            <View style={{ flexDirection: 'row', gap: 24, flexWrap: 'wrap' }}>
              <View style={{ gap: 2 }}>
                <T size={28} weight="800" color={c.pink}>{local?.queued ?? 0}</T>
                <T size={11} color={c.mute}>{t('rof.queued_ops')}</T>
              </View>
              <View style={{ gap: 2 }}>
                <T size={28} weight="800" color={(local?.conflicts ?? 0) > 0 ? c.sun : c.mint}>{local?.conflicts ?? 0}</T>
                <T size={11} color={c.mute}>{t('rof.conflict_count')}</T>
              </View>
              <View style={{ gap: 2 }}>
                <T size={13} weight="700" color={c.mute} style={{ marginTop: 8 }}>{status?.last_sync_at ? fmt(status.last_sync_at) : '—'}</T>
                <T size={11} color={c.mute}>{t('rof.last_sync')}</T>
              </View>
            </View>
            <Btn
              title={busy ? t('rof.syncing') : t('rof.force_sync')}
              loading={busy}
              onPress={forceSync}
              style={{ minHeight: 48 }}
              accessibilityLabel={t('rof.force_sync')}
            />
          </View>
        </Card>

        {/* Conflicts */}
        {conflicts.length > 0 && (
          <Section title={t('rof.conflicts_section')} color={c.sun}>
            {conflicts.map((op) => (
              <Card key={op.id} pad={14} style={{ borderLeftWidth: 3, borderLeftColor: c.sun }}>
                <View style={{ gap: 8 }}>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    <Tag label={op.op_type} color={c.sunSoft} />
                    <Tag label={`seq ${op.seq}`} color={c.line} />
                  </View>
                  <T size={12.5} color={c.mute}>{fmt(op.occurred_at)}</T>
                  {op.conflict_data ? <T size={12} color={c.mute}>{JSON.stringify(op.conflict_data)}</T> : null}
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Btn
                      title={t('rof.accept_conflict')}
                      onPress={() => resolve(op.id, 'accept')}
                      style={{ flex: 1, minHeight: 44 }}
                      accessibilityLabel={t('rof.accept_conflict')}
                    />
                    <Btn
                      title={t('rof.discard_conflict')}
                      onPress={() => resolve(op.id, 'discard')}
                      style={{ flex: 1, minHeight: 44, backgroundColor: c.red }}
                      accessibilityLabel={t('rof.discard_conflict')}
                    />
                  </View>
                </View>
              </Card>
            ))}
          </Section>
        )}

        {/* Op history */}
        <Section title={t('rof.history_section')} color={c.violet}>
          {history.length === 0
            ? <T size={13} color={c.mute}>{t('rof.no_history')}</T>
            : history.map((op) => (
              <Card key={op.id} pad={12}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  <Tag label={op.op_type} color={OP_COLOR[op.status] ?? c.line} />
                  <Tag label={op.status} color={OP_COLOR[op.status] ?? c.line} />
                  <T size={12} color={c.mute} style={{ flex: 1 }}>{op.official_name} · {fmt(op.occurred_at)}</T>
                </View>
              </Card>
            ))
          }
        </Section>
      </ScrollView>
    </Screen>
  );
}
