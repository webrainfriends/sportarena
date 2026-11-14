import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { Btn, Card, Empty, ErrorBox, H1, Loading, Screen, T } from '../ui';
import { useLayout } from '../layout';
import { useNav } from '../nav';
import { c } from '../theme';
import { t } from '../i18n';
import { useApi, useApiMutation } from '../api';

function SessionRow({ item, onPress }) {
  const preview = item.last_preview?.role === 'assistant'
    ? t('concierge.lastReply')
    : item.last_preview?.role === 'user'
    ? t('concierge.lastYou')
    : null;
  const ts = item.last_message_at
    ? new Date(item.last_message_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => onPress(item)}
      accessibilityRole="button"
      accessibilityLabel={item.title ?? t('concierge.untitledSession')}
    >
      <View style={styles.rowInner}>
        <View style={styles.rowLeft}>
          <T style={styles.rowTitle} numberOfLines={1}>{item.title ?? t('concierge.untitledSession')}</T>
          {preview ? <T style={styles.rowPreview} numberOfLines={1}>{preview}</T> : null}
        </View>
        {ts ? <T style={styles.rowTs}>{ts}</T> : null}
      </View>
    </Pressable>
  );
}

export function ConciergeSessions() {
  const { push } = useNav();
  const { tablet } = useLayout();
  const [status, setStatus] = useState('active');

  const { data, loading, error, refetch } = useApi('list_concierge_sessions', { status });
  const { mutate: startSession, loading: starting } = useApiMutation('start_concierge_session');

  const handleNew = useCallback(async () => {
    try {
      const session = await startSession({ title: null, context: {} });
      if (session?.id) push('Concierge', { session_id: session.id, fresh: true });
    } catch { /* errors surfaced by ErrorBox */ }
  }, [startSession, push]);

  const handleOpen = useCallback((item) => {
    push('Concierge', { session_id: item.id });
  }, [push]);

  const sessions = data?.sessions ?? [];

  return (
    <Screen>
      <View style={[styles.header, tablet && styles.headerTablet]}>
        <H1>{t('nav.title.ConciergeSessions')}</H1>
        <Btn
          label={t('concierge.new_session')}
          onPress={handleNew}
          loading={starting}
          icon="plus"
          accessibilityLabel={t('concierge.new_session')}
        />
      </View>

      {/* Status tabs */}
      <View style={styles.tabs}>
        {['active', 'archived'].map((s) => (
          <Pressable
            key={s}
            style={[styles.tab, status === s && styles.tabActive]}
            onPress={() => setStatus(s)}
            accessibilityRole="tab"
            accessibilityState={{ selected: status === s }}
          >
            <T style={[styles.tabLabel, status === s && styles.tabLabelActive]}>
              {s === 'active' ? t('concierge.tabActive') : t('concierge.tabArchived')}
            </T>
          </Pressable>
        ))}
      </View>

      {error ? <ErrorBox error={error} onRetry={refetch} /> : null}
      {loading && !data ? <Loading /> : null}

      {!loading && sessions.length === 0 && !error ? (
        <Empty
          icon="chat"
          title={t('concierge.empty_sessions_title')}
          body={t('concierge.empty_sessions')}
          action={t('concierge.new_session')}
          onAction={handleNew}
        />
      ) : (
        <FlatList
          data={sessions}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <SessionRow item={item} onPress={handleOpen} />}
          contentContainerStyle={tablet ? styles.listTablet : styles.list}
          onRefresh={refetch}
          refreshing={loading && Boolean(data)}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  headerTablet: { paddingHorizontal: 24 },
  tabs: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.line, marginHorizontal: 16 },
  tab: { paddingHorizontal: 16, paddingVertical: 10 },
  tabActive: { borderBottomWidth: 2, borderBottomColor: c.pink },
  tabLabel: { fontSize: 14, color: c.mute },
  tabLabelActive: { color: c.pink, fontWeight: '600' },
  list: { paddingBottom: 80 },
  listTablet: { paddingBottom: 80, maxWidth: 720, alignSelf: 'center', width: '100%' },
  row: { backgroundColor: c.paper, marginHorizontal: 16, marginTop: 8, borderRadius: 10, borderWidth: 1, borderColor: c.line },
  rowPressed: { opacity: 0.75 },
  rowInner: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
  rowLeft: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: '600', color: c.ink },
  rowPreview: { fontSize: 13, color: c.mute, marginTop: 2 },
  rowTs: { fontSize: 12, color: c.mute, flexShrink: 0 },
});
