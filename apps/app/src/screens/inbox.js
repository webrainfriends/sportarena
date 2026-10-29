import React from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useWorkspace } from '../workspace';
import { targetFor } from '../push';
import { Bubble, Btn, Empty, ErrorBox, H1, Loading, Row, Screen, T } from '../ui';
import { c } from '../theme';
import { locale } from '../locale';

const EMOJI = (k) => (k.includes('cancel') ? '❌' : k.includes('remind') ? '⏰' : k.includes('modif') ? '✏️' : '✅');

/** Inbox: every notification in one list, newest first. A tap marks it read and opens the record it is about, using the same
 *  mapping as a tapped push notification, so the inbox, the push and a deep link always land on the same screen. */
export function Inbox() {
  const { push, goTab } = useNav();
  const ws = useWorkspace();
  const list = useLoad(() => api.get('/notifications', { limit: 50 }), []);
  const readAll = async () => { await api.post('/notifications/read', {}); list.reload(); ws?.reload(); };
  const tap = async (n) => {
    if (!n.read_at) { await api.post('/notifications/read', { ids: [n.id] }).catch(() => {}); list.reload(); ws?.reload(); }
    const d = n.data ?? {};
    if (d.trip_id) return push('Trip', { id: d.trip_id });
    if (d.request_id && !d.event_id) return push('CoachRequest', { id: d.request_id });
    if (d.hire_id || d.review_id) return ['coach_hire_request', 'coach_review', 'coach_response_accepted'].includes(n.kind) ? push('CoachDesk') : goTab('Schedule', { section: 'coach' });
    const [screen, params] = targetFor(d);
    if (screen !== 'Inbox') push(screen, params);
  };
  const unread = list.data?.unread ?? 0;
  return (
    <Screen onRefresh={list.reload} refreshing={list.loading && !!list.data}>
      <H1 style={{ marginTop: 4 }}>Inbox</H1>
      <T color={c.mute} weight="600" accessibilityLiveRegion="polite">{unread ? `${unread} unread` : 'All read'}</T>
      <View style={{ flexDirection: 'row', gap: 10, marginVertical: 12, flexWrap: 'wrap' }}>
        {unread ? <Btn small title="Mark all read" color={c.paper} ink={c.ink} onPress={readAll} /> : null}
        <Btn small title="Notification settings" color={c.paper} ink={c.ink} onPress={() => push('Notifications')} />
      </View>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.items.length ? list.data.items.map((n) => (
        <Row key={n.id} onPress={() => tap(n)} color={n.read_at ? c.paper : c.pinkSoft} left={<Bubble emoji={EMOJI(n.kind)} />}
          title={n.title} sub={`${n.body ? `${n.body} · ` : ''}${new Date(n.created_at).toLocaleString(locale)}${n.read_at ? '' : ' · unread'}`} />
      )) : <Empty emoji="🔕" title="Nothing yet" sub="Requests, confirmations, changes and reminders land here." />}
    </Screen>
  );
}
