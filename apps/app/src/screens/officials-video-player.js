// Authorised Video Player with incident timeline, multi-angle switcher and marker panel (#1023).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, Loading, Screen, Section, Sheet, T, Tag } from '../ui';
import { c, grad, r } from '../theme';
import { t } from '../i18n';
import { tapped } from '../haptics';
import { useLayout } from '../layout';

// ─── helpers ────────────────────────────────────────────────────────────────
const fmtMs = (ms) => {
  if (ms == null) return '0:00';
  const totalS = Math.floor(ms / 1000);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

const severityColor = { low: c.cyan, medium: c.sun, high: c.orange, critical: c.red };
const severityBg = { low: c.cyanSoft, medium: c.sunSoft, high: c.orangeSoft, critical: c.redSoft };
const markerTypeIcon = {
  incident: '⚠', warning: '🟡', decision: '⚖', disputed: '❓',
  evidence: '📌', performance: '⭐', advantage: '✅',
};

// ─── Marker dot on timeline ──────────────────────────────────────────────────
function TimelineDot({ marker, durationMs, onPress, currentMs }) {
  if (!durationMs) return null;
  const pct = Math.min(100, (marker.timestamp_ms / durationMs) * 100);
  const isActive = currentMs != null && Math.abs(currentMs - marker.timestamp_ms) < 3000;
  return (
    <Pressable
      onPress={tapped(onPress)}
      style={{
        position: 'absolute',
        left: `${pct}%`,
        top: -6,
        transform: [{ translateX: -6 }],
        width: 12, height: 12, borderRadius: 6,
        backgroundColor: severityColor[marker.severity],
        borderWidth: isActive ? 2 : 0, borderColor: '#fff',
        shadowColor: severityColor[marker.severity], shadowOpacity: isActive ? 0.8 : 0.4,
        shadowRadius: isActive ? 6 : 3, shadowOffset: { width: 0, height: 0 }, elevation: 4,
      }}
      accessibilityLabel={`${marker.marker_type} at ${fmtMs(marker.timestamp_ms)}`}
    />
  );
}

// ─── Angle chip ──────────────────────────────────────────────────────────────
function AngleChip({ angle, active, onPress }) {
  return (
    <Pressable
      onPress={tapped(onPress)}
      style={{
        backgroundColor: active ? c.pink : c.paper,
        borderRadius: r.pill, paddingHorizontal: 12, paddingVertical: 6,
        borderWidth: 1, borderColor: active ? c.pink : c.line,
        marginRight: 8,
      }}
      accessibilityLabel={angle}
    >
      <T size={11} weight="700" color={active ? '#fff' : c.mute}>{angle}</T>
    </Pressable>
  );
}

// ─── Marker list row ─────────────────────────────────────────────────────────
function MarkerListRow({ marker, isCurrent, onPress }) {
  return (
    <Pressable
      onPress={tapped(onPress)}
      style={({ pressed }) => [{
        flexDirection: 'row', alignItems: 'center', gap: 10,
        backgroundColor: isCurrent ? c.pinkSoft : c.paper,
        borderRadius: 12, padding: 12, marginBottom: 6,
        opacity: pressed ? 0.8 : 1,
        borderWidth: isCurrent ? 1.5 : 0, borderColor: c.pink,
      }]}
    >
      <View style={{
        width: 44, alignItems: 'center', backgroundColor: severityBg[marker.severity],
        borderRadius: r.pill, paddingVertical: 3,
      }}>
        <T size={10} weight="800" color={severityColor[marker.severity]} style={{ fontVariant: ['tabular-nums'] }}>
          {fmtMs(marker.timestamp_ms)}
        </T>
      </View>
      <T size={15}>{markerTypeIcon[marker.marker_type] ?? '📌'}</T>
      <View style={{ flex: 1 }}>
        <T size={12} weight="700" color={c.ink}>
          {marker.sport_event_code?.replace(/_/g, ' ') ?? marker.marker_type.replace(/_/g, ' ')}
        </T>
        {marker.angle_ref ? <T size={10} color={c.mute}>📐 {marker.angle_ref}</T> : null}
      </View>
      {!marker.resolved_at ? (
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: severityColor[marker.severity] }} />
      ) : (
        <T size={12} color={c.lime}>✓</T>
      )}
    </Pressable>
  );
}

// ─── Add Marker Sheet ────────────────────────────────────────────────────────
const MARKER_TYPES = ['incident', 'warning', 'decision', 'disputed', 'evidence', 'performance', 'advantage'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

function AddMarkerSheet({ visible, onClose, onSave, currentMs, videoId, angles }) {
  const [type, setType] = useState('incident');
  const [severity, setSeverity] = useState('medium');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useSession();

  const handleSave = async () => {
    setLoading(true);
    try {
      await onSave({ type, severity, note, timestamp_ms: currentMs });
      setNote('');
      onClose();
    } catch (e) {
      toast(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('officialVideo.marker.add')}>
      <View style={{ gap: 14, paddingBottom: 20 }}>
        <T size={12} color={c.mute}>{t('officialVideo.marker.at_time')}: <T weight="700" color={c.ink}>{fmtMs(currentMs)}</T></T>

        {/* Type */}
        <View>
          <T size={11} weight="700" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{t('officialVideo.marker.type_label')}</T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {MARKER_TYPES.map((mt) => (
                <Pressable key={mt} onPress={tapped(() => setType(mt))} style={{
                  backgroundColor: type === mt ? c.pinkSoft : c.paper,
                  borderRadius: r.pill, paddingHorizontal: 12, paddingVertical: 6,
                  borderWidth: 1, borderColor: type === mt ? c.pink : c.line,
                }}>
                  <T size={11} weight="700" color={type === mt ? c.pink : c.mute}>
                    {markerTypeIcon[mt]} {t(`officialVideo.marker.type.${mt}`) ?? mt}
                  </T>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </View>

        {/* Severity */}
        <View>
          <T size={11} weight="700" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{t('officialVideo.severity_label')}</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {SEVERITIES.map((sv) => (
              <Pressable key={sv} onPress={tapped(() => setSeverity(sv))} style={{
                flex: 1, backgroundColor: severity === sv ? severityBg[sv] : c.paper,
                borderRadius: r.pill, paddingVertical: 8, alignItems: 'center',
                borderWidth: 1, borderColor: severity === sv ? severityColor[sv] : c.line,
              }}>
                <T size={11} weight="700" color={severity === sv ? severityColor[sv] : c.mute}>
                  {t(`officialVideo.severity.${sv}`) ?? sv}
                </T>
              </Pressable>
            ))}
          </View>
        </View>

        <Btn label={t('officialVideo.marker.save')} onPress={handleSave} loading={loading} />
      </View>
    </Sheet>
  );
}

// ─── Export Request Sheet ────────────────────────────────────────────────────
function ExportSheet({ visible, onClose, videoId }) {
  const [loading, setLoading] = useState(false);
  const { toast } = useSession();

  const handleRequest = async () => {
    setLoading(true);
    try {
      await api.post(`/match-videos/${videoId}/export-requests`, { purpose: 'federation_inquiry', recipient_org: '' });
      toast(t('officialVideo.export.requested'));
      onClose();
    } catch (e) {
      toast(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('officialVideo.export.request_title')}>
      <View style={{ gap: 14, paddingBottom: 20 }}>
        <View style={{ backgroundColor: c.sunSoft, borderRadius: 12, padding: 12 }}>
          <T size={12} color={c.sun} weight="600">⚠ {t('officialVideo.export.policy_note')}</T>
        </View>
        <Btn label={t('officialVideo.export.request_cta')} onPress={handleRequest} loading={loading} />
      </View>
    </Sheet>
  );
}

// ─── MAIN PLAYER SCREEN ──────────────────────────────────────────────────────

export function OfficialVideoPlayer({ fixtureId, videoId, sessionId }) {
  const { back, push } = useNav();
  const { toast } = useSession();
  const L = useLayout();
  const [currentMs, setCurrentMs] = useState(0);
  const [addMarkerVisible, setAddMarkerVisible] = useState(false);
  const [exportVisible, setExportVisible] = useState(false);
  const [activeVideoId, setActiveVideoId] = useState(videoId);
  const [panelTab, setPanelTab] = useState('markers'); // markers | participants | audit
  const videoRef = useRef(null);

  const videosLoad = useLoad(() => api.get(`/fixtures/${fixtureId}/match-videos`), [fixtureId]);
  const videos = videosLoad.data?.videos ?? [];
  const activeVideo = videos.find((v) => v.id === activeVideoId) ?? videos[0];

  const markersLoad = useLoad(() => activeVideoId ? api.get(`/match-videos/${activeVideoId}/markers`) : Promise.resolve({ markers: [] }), [activeVideoId]);
  const markers = markersLoad.data?.markers ?? [];

  const sessionLoad = useLoad(() => sessionId ? api.get(`/video-review-sessions/${sessionId}`) : Promise.resolve(null), [sessionId]);
  const session = sessionLoad.data?.session;

  const participantsLoad = useLoad(() => sessionId ? api.get(`/video-review-sessions/${sessionId}`) : Promise.resolve(null), [sessionId]);
  const participants = participantsLoad.data?.session?.participants ?? [];

  const durationMs = activeVideo?.duration_ms ?? 0;
  const progressPct = durationMs > 0 ? Math.min(100, (currentMs / durationMs) * 100) : 0;

  const handleScrubToMarker = (marker) => {
    setCurrentMs(marker.timestamp_ms);
    // On web, seek the video element
    if (Platform.OS === 'web' && videoRef.current) {
      videoRef.current.currentTime = marker.timestamp_ms / 1000;
    }
  };

  const handleAddMarker = async ({ type, severity, note, timestamp_ms }) => {
    if (!activeVideoId) throw new Error(t('officialVideo.error.no_video'));
    await api.post(`/match-videos/${activeVideoId}/markers`, {
      timestamp_ms, marker_type: type, severity,
      note: note || undefined,
    });
    markersLoad.reload();
  };

  const handleResolveMarker = async (marker) => {
    await api.post(`/incident-markers/${marker.id}/resolve`, {});
    markersLoad.reload();
  };

  const isTablet = L.width >= 768;

  if (videosLoad.loading && !videos.length) return <Screen><Loading /></Screen>;

  const playerArea = (
    <View style={{ backgroundColor: '#000' }}>
      {/* Video element */}
      <View style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: '#111', justifyContent: 'center', alignItems: 'center' }}>
        {activeVideo ? (
          Platform.OS === 'web' ? (
            <video
              ref={videoRef}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              controls
              onTimeUpdate={(e) => setCurrentMs(Math.floor(e.target.currentTime * 1000))}
              src={activeVideo.stream_url ?? undefined}
            >
              {t('officialVideo.player.no_stream')}
            </video>
          ) : (
            // Native: placeholder (requires Expo AV in real implementation)
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
              <T size={40}>🎬</T>
              <T size={13} color="#fff" style={{ marginTop: 8 }}>{activeVideo.angle_label}</T>
              <T size={11} color="#888">{fmtMs(currentMs)} / {fmtMs(durationMs)}</T>
            </View>
          )
        ) : (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <T size={40}>🎬</T>
            <T size={13} color="#888" style={{ marginTop: 8 }}>{t('officialVideo.empty.videos')}</T>
          </View>
        )}
      </View>

      {/* Angle switcher */}
      {videos.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ backgroundColor: '#1a1a2e', paddingVertical: 8, paddingHorizontal: 12 }}>
          {videos.map((v) => (
            <AngleChip key={v.id} angle={v.angle_label} active={v.id === activeVideoId} onPress={() => setActiveVideoId(v.id)} />
          ))}
        </ScrollView>
      ) : null}

      {/* Timeline */}
      <View style={{ backgroundColor: '#1a1a2e', paddingHorizontal: 12, paddingBottom: 12, paddingTop: 4 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
          <T size={10} color="#888" style={{ fontVariant: ['tabular-nums'] }}>{fmtMs(currentMs)}</T>
          <T size={10} color="#888" style={{ fontVariant: ['tabular-nums'] }}>{fmtMs(durationMs)}</T>
        </View>
        {/* Progress bar + marker dots */}
        <View style={{ position: 'relative', height: 20 }}>
          <View style={{ position: 'absolute', top: 7, left: 0, right: 0, height: 6, backgroundColor: '#333', borderRadius: 3 }} />
          <View style={{ position: 'absolute', top: 7, left: 0, width: `${progressPct}%`, height: 6, backgroundColor: c.pink, borderRadius: 3 }} />
          {markers.map((m) => (
            <TimelineDot key={m.id} marker={m} durationMs={durationMs} currentMs={currentMs} onPress={() => handleScrubToMarker(m)} />
          ))}
        </View>
        {/* Controls row */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <Pressable onPress={tapped(() => setAddMarkerVisible(true))} style={{
            backgroundColor: c.pink, borderRadius: r.pill, paddingHorizontal: 14, paddingVertical: 7, flexDirection: 'row', gap: 4, alignItems: 'center',
          }}>
            <T size={12} weight="700" color="#fff">📌 {t('officialVideo.marker.add_cta')}</T>
          </Pressable>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable onPress={tapped(() => setExportVisible(true))} style={{
              backgroundColor: '#333', borderRadius: r.pill, paddingHorizontal: 12, paddingVertical: 7,
            }}>
              <T size={12} weight="700" color="#aaa">📤 {t('officialVideo.export.cta')}</T>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );

  const panelArea = (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {/* Panel tab strip */}
      <View style={{ flexDirection: 'row', backgroundColor: c.paper, borderBottomWidth: 1, borderColor: c.line }}>
        {[['markers', t('officialVideo.panel.markers')], ['participants', t('officialVideo.panel.participants')], ['audit', t('officialVideo.panel.audit')]].map(([key, label]) => (
          <Pressable key={key} onPress={tapped(() => setPanelTab(key))} style={{
            flex: 1, paddingVertical: 10, alignItems: 'center',
            borderBottomWidth: 2, borderColor: panelTab === key ? c.pink : 'transparent',
          }}>
            <T size={10} weight="700" color={panelTab === key ? c.pink : c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</T>
          </Pressable>
        ))}
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 40 }}>
        {panelTab === 'markers' ? (
          markers.length ? (
            markers.sort((a, b) => a.timestamp_ms - b.timestamp_ms).map((m) => (
              <MarkerListRow
                key={m.id}
                marker={m}
                isCurrent={Math.abs(currentMs - m.timestamp_ms) < 3000}
                onPress={() => handleScrubToMarker(m)}
              />
            ))
          ) : (
            <Empty icon="📌" title={t('officialVideo.empty.incidents')} subtitle={t('officialVideo.empty.incidents_sub')} />
          )
        ) : panelTab === 'participants' ? (
          session ? (
            <View style={{ gap: 8 }}>
              <T size={12} weight="700" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
                {t(`officialVideo.review.type.${session.review_type}`) ?? session.review_type}
              </T>
              {participants.map((p) => (
                <View key={p.user_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.paper, borderRadius: 12, padding: 10 }}>
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.pinkSoft, justifyContent: 'center', alignItems: 'center' }}>
                    <T size={14} weight="700" color={c.pink}>{(p.name ?? '?')[0]}</T>
                  </View>
                  <View style={{ flex: 1 }}>
                    <T size={13} weight="600" color={c.ink}>{p.name}</T>
                    <T size={11} color={c.mute}>{t(`officialVideo.review.role.${p.role}`) ?? p.role}</T>
                  </View>
                  {p.last_seen_at ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.lime }} /> : null}
                </View>
              ))}
            </View>
          ) : (
            <Empty icon="👥" title={t('officialVideo.empty.no_session')} subtitle={t('officialVideo.empty.no_session_sub')} />
          )
        ) : (
          // Audit tab
          <View>
            <T size={11} color={c.mute}>{t('officialVideo.audit.note')}</T>
          </View>
        )}
      </ScrollView>
    </View>
  );

  return (
    <Screen>
      {isTablet ? (
        // Tablet: player left, panel right
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ flex: 3 }}>
            {playerArea}
          </View>
          <View style={{ flex: 2, borderLeftWidth: 1, borderColor: c.line }}>
            {panelArea}
          </View>
        </View>
      ) : (
        // Phone: player top, panel bottom
        <View style={{ flex: 1 }}>
          {playerArea}
          {panelArea}
        </View>
      )}

      <AddMarkerSheet
        visible={addMarkerVisible}
        onClose={() => setAddMarkerVisible(false)}
        onSave={handleAddMarker}
        currentMs={currentMs}
        videoId={activeVideoId}
        angles={videos.map((v) => v.angle_label)}
      />
      <ExportSheet
        visible={exportVisible}
        onClose={() => setExportVisible(false)}
        videoId={activeVideoId}
      />
    </Screen>
  );
}
