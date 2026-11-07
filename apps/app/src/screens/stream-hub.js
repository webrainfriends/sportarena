// Family-facing live stream and replay hub (feature 5).
// StreamHub: personalised feed. StreamViewer: full-screen player with overlays.
import React, { useState } from 'react';
import { View, ScrollView, TouchableOpacity } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, GradCard, H2, HScroll, Loading, Row, Screen, Section, T, Tag } from '../ui';
import { c, grad, toneFor } from '../theme';
import { t } from '../i18n';

function LiveBadge() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.red }} />
      <T weight="800" size={11} color={c.red}>{t('sh.live_badge')}</T>
    </View>
  );
}

function StreamCard({ stream, onWatch, onToggleAlert, alerted }) {
  const tone = toneFor(stream.sport_slug ?? stream.team_name);
  return (
    <Card pad={0} style={{ overflow: 'hidden' }} accessibilityLabel={stream.event_name}>
      {/* Thumbnail gradient */}
      <View style={{ height: 80, backgroundColor: tone[0], justifyContent: 'flex-end', padding: 10 }}>
        {stream.is_live ? <LiveBadge /> : <Tag label={t('sh.replay_badge')} color={c.violet} />}
      </View>
      <View style={{ padding: 12, gap: 6 }}>
        <T weight="700">{stream.event_name}</T>
        <T size={12} color={c.mute}>{stream.team_name} · {new Date(stream.starts_at ?? stream.replay_available_at).toLocaleString()}</T>
        {stream.child_playing && (
          <Tag label={stream.child_name ? t('sh.child_playing_named', { name: stream.child_name }) : t('sh.child_playing')} color={c.pink} />
        )}
        {stream.is_live && stream.viewer_count > 0 && (
          <T size={12} color={c.mute}>{t('sh.watching', { n: stream.viewer_count })}</T>
        )}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
          <Btn small title={stream.is_live ? t('sh.watch_live') : t('sh.watch_replay')} color={c.pink}
            onPress={() => onWatch(stream)} />
          {!stream.is_live && (
            <Btn small
              title={alerted ? t('sh.alert_on') : t('sh.alert_off')}
              color={alerted ? c.lime : c.paper} ink={alerted ? c.paper : c.ink}
              onPress={() => onToggleAlert(stream.team_id, alerted)} />
          )}
        </View>
      </View>
    </Card>
  );
}

export function StreamHub() {
  const { push } = useNav();
  const { toast } = useSession();
  const [alertsSheet, setAlertsSheet] = useState(false);

  const feed = useLoad(() => api.get('/me/stream-feed'), []);
  const alerts = useLoad(() => api.get('/me/stream-alerts'), []);

  const alertedTeams = new Set((alerts.data?.subscriptions ?? []).map(s => s.team_id));

  const handleWatch = (stream) => {
    push('StreamViewer', { streamId: stream.id, initialUrl: stream.stream_url ?? stream.replay_url });
  };

  const toggleAlert = async (teamId, currentlyAlerting) => {
    if (currentlyAlerting) {
      await api.delete(`/stream-alerts/${teamId}`);
      toast(t('sh.alert_unsubscribed'));
    } else {
      await api.post(`/stream-alerts/${teamId}`, {});
      toast(t('sh.alert_subscribed'));
    }
    alerts.reload();
  };

  if (feed.loading && !feed.data) return <Loading />;
  if (feed.error) return <ErrorBox error={feed.error} onRetry={feed.reload} />;

  const { live_now = [], upcoming = [], recently_ended = [], discover = [] } = feed.data ?? {};

  return (
    <Screen title={t('sh.title')}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 20 }}>
        {/* Manage alerts button */}
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Btn small title={`🔔 ${t('sh.manage_alerts')}`} color={c.paper} ink={c.ink} onPress={() => setAlertsSheet(true)} />
        </View>

        {/* Live Now */}
        {live_now.length > 0 && (
          <Section title={t('sh.live_now')} color={c.red}>
            {live_now.map(s => (
              <StreamCard key={s.id} stream={s} onWatch={handleWatch} onToggleAlert={toggleAlert} alerted={alertedTeams.has(s.team_id)} />
            ))}
          </Section>
        )}

        {/* My Children's Games */}
        {upcoming.filter(s => s.child_playing).length > 0 && (
          <Section title={t('sh.my_children_games')} color={c.pink}>
            {upcoming.filter(s => s.child_playing).map(s => (
              <StreamCard key={s.id} stream={s} onWatch={handleWatch} onToggleAlert={toggleAlert} alerted={alertedTeams.has(s.team_id)} />
            ))}
          </Section>
        )}

        {/* Replays */}
        {recently_ended.length > 0 ? (
          <Section title={t('sh.replays')} color={c.violet}>
            {recently_ended.map(s => (
              <Card key={s.id} pad={12} accessibilityLabel={s.event_name}>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                  <View style={{ width: 48, height: 48, borderRadius: 8, backgroundColor: toneFor(s.team_name)[0] }} />
                  <View style={{ flex: 1 }}>
                    <T weight="700">{s.event_name}</T>
                    <T size={12} color={c.mute}>{s.team_name}</T>
                    {s.duration_seconds && <T size={12} color={c.mute}>{Math.round(s.duration_seconds / 60)}min</T>}
                    {s.child_playing && <Tag label={s.child_name ?? t('sh.child_playing')} color={c.pink} />}
                    {/* Event markers preview */}
                    {s.event_markers?.length > 0 && (
                      <HScroll style={{ marginTop: 4 }}>
                        {s.event_markers.slice(0, 6).map((m, i) => (
                          <T key={i} size={11} color={c.mute} style={{ marginRight: 6 }}>
                            {m.type === 'goal' ? '⚽' : m.type === 'card' ? '🟨' : m.type === 'try' ? '🏉' : '•'} {m.minute}'
                          </T>
                        ))}
                      </HScroll>
                    )}
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  <Btn small title={t('sh.watch_replay')} color={c.pink} onPress={() => handleWatch(s)} />
                  <Btn small title={t('sh.clip')} color={c.paper} ink={c.ink} onPress={() => toast('Copy replay link with timestamp')} />
                </View>
              </Card>
            ))}
          </Section>
        ) : (
          <Empty emoji="📹" title={t('sh.empty_replays')} sub="" />
        )}

        {/* Discover */}
        {discover.length > 0 && (
          <Section title={t('sh.discover')} color={c.cyan}>
            {discover.map(s => (
              <StreamCard key={s.id} stream={s} onWatch={handleWatch} onToggleAlert={toggleAlert} alerted={alertedTeams.has(s.team_id)} />
            ))}
          </Section>
        )}

        {live_now.length === 0 && recently_ended.length === 0 && discover.length === 0 && (
          <Empty emoji="📺" title={t('sh.empty_live')} sub={t('sh.empty_live_sub')} />
        )}
      </ScrollView>
    </Screen>
  );
}

export function StreamViewer({ streamId, initialUrl }) {
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessage, setChatMessage] = useState('');
  const { back } = useNav();
  const { toast } = useSession();

  const q = useLoad(() => api.get(`/event-streams/${streamId}`).catch(() => null), [streamId]);
  const chat = useLoad(() => api.get(`/event-streams/${streamId}/chat`), [streamId]);

  const stream = q.data?.stream ?? null;
  const url = initialUrl ?? stream?.stream_url ?? stream?.replay_url;

  const sendMessage = async () => {
    if (!chatMessage.trim()) return;
    await api.post(`/event-streams/${streamId}/chat`, { message: chatMessage });
    setChatMessage('');
    chat.reload();
  };

  return (
    <Screen title={stream?.event_name ?? t('nav.title.StreamViewer')} style={{ backgroundColor: '#000' }}>
      {/* Player area */}
      <View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' }}>
        {url ? (
          <T color="#fff" style={{ opacity: 0.6 }}>Stream: {url}</T>
        ) : (
          <T color="#fff" style={{ opacity: 0.6 }}>{t('sh.empty_live')}</T>
        )}

        {/* Stream markers scrubber (replay only) */}
        {stream?.is_replay && stream?.event_markers?.length > 0 && (
          <HScroll style={{ position: 'absolute', bottom: 60, paddingHorizontal: 16 }}>
            {stream.event_markers.map((m, i) => (
              <TouchableOpacity key={i} style={{ marginRight: 12, alignItems: 'center' }}>
                <T size={18}>{m.type === 'goal' ? '⚽' : m.type === 'try' ? '🏉' : m.type === 'card' ? '🟨' : '•'}</T>
                <T size={10} color="#fff" style={{ opacity: 0.7 }}>{m.minute}'</T>
              </TouchableOpacity>
            ))}
          </HScroll>
        )}
      </View>

      {/* Chat toggle */}
      {stream?.allow_family_chat !== false && (
        <View style={{ padding: 8, backgroundColor: c.paper, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Btn small title={chatOpen ? '▼ Chat' : `💬 ${t('sh.chat')}`} color={c.paper} ink={c.ink} onPress={() => setChatOpen(o => !o)} />
        </View>
      )}

      {chatOpen && (
        <View style={{ maxHeight: 200, backgroundColor: c.paper, padding: 8, gap: 4 }}>
          <ScrollView>
            {(chat.data?.messages ?? []).map(m => (
              <T key={m.id} size={12} style={{ paddingVertical: 2 }}>
                <T weight="700">{m.display_name}: </T>{m.message}
              </T>
            ))}
          </ScrollView>
          <Row style={{ gap: 8 }}>
            <Btn small title={t('sh.chat_send')} color={c.pink} onPress={sendMessage} />
          </Row>
        </View>
      )}
    </Screen>
  );
}
