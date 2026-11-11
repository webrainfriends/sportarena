// Authorised Video Review Workspace (#1023). Match footage, incident markers, review sessions and exports for officials.
import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, GradCard, Loading, Screen, Section, Sheet, T, Tag } from '../ui';
import { c, grad, r } from '../theme';
import { t } from '../i18n';
import { tapped } from '../haptics';
import { useLayout } from '../layout';

// ─── helpers ────────────────────────────────────────────────────────────────
const fmtDuration = (ms) => {
  if (!ms) return '';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s`;
};

const fmtMs = (ms) => {
  if (ms == null) return '';
  const totalS = Math.floor(ms / 1000);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = totalS % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

const fmtBytes = (b) => {
  if (!b) return '';
  if (b > 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b > 1e6) return `${(b / 1e6).toFixed(0)} MB`;
  return `${b} B`;
};

const purposeColor = {
  match_record: c.cyan, incident_evidence: c.orange, dispute_evidence: c.red,
  assessment_footage: c.pink, federation_inquiry: c.violet,
};
const purposeSoft = {
  match_record: c.cyanSoft, incident_evidence: c.orangeSoft, dispute_evidence: c.redSoft,
  assessment_footage: c.pinkSoft, federation_inquiry: c.violetSoft,
};
const severityColor = { low: c.cyan, medium: c.sun, high: c.orange, critical: c.red };
const statusColor = {
  open: c.cyanSoft, in_progress: c.sunSoft, pending_evidence: c.orangeSoft,
  concluded: c.limeSoft, appealed: c.redSoft, closed: c.violetSoft,
};
const statusInk = {
  open: c.cyan, in_progress: c.sun, pending_evidence: c.orange,
  concluded: c.lime, appealed: c.red, closed: c.violet,
};
const exportStatusColor = { pending: c.sunSoft, approved: c.cyanSoft, rejected: c.redSoft, delivered: c.limeSoft, expired: c.violetSoft, revoked: c.redSoft };
const exportStatusInk = { pending: c.sun, approved: c.cyan, rejected: c.red, delivered: c.lime, expired: c.mute, revoked: c.red };

// ─── SUBCOMPONENTS ──────────────────────────────────────────────────────────

function MetricStrip({ videos, markers, sessions, exports: exps }) {
  const items = [
    { val: videos ?? 0, lbl: t('officialVideo.metric_angles') },
    { val: markers ?? 0, lbl: t('officialVideo.metric_incidents') },
    { val: sessions ?? 0, lbl: t('officialVideo.metric_reviews') },
    { val: exps ?? 0, lbl: t('officialVideo.metric_exports') },
  ];
  return (
    <View style={{ flexDirection: 'row', backgroundColor: c.paper, borderBottomWidth: 1, borderColor: c.line }}>
      {items.map((item, idx) => (
        <View key={idx} style={{ flex: 1, alignItems: 'center', paddingVertical: 10, borderRightWidth: idx < items.length - 1 ? 1 : 0, borderColor: c.line }}>
          <T weight="800" size={20} color={c.ink}>{item.val}</T>
          <T size={10} color={c.mute} weight="700" style={{ textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 1 }}>{item.lbl}</T>
        </View>
      ))}
    </View>
  );
}

function PurposeChip({ purpose }) {
  const label = t(`officialVideo.purpose.${purpose}`) ?? purpose.replace(/_/g, ' ');
  return (
    <View style={{ backgroundColor: purposeSoft[purpose] ?? c.violetSoft, borderRadius: r.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
      <T size={10} weight="700" color={purposeColor[purpose] ?? c.mute}>{label}</T>
    </View>
  );
}

function SeverityDot({ severity, size = 8 }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: severityColor[severity] ?? c.mute }} />;
}

function VideoCard({ video, onPress }) {
  return (
    <Pressable onPress={tapped(onPress)} style={({ pressed }) => [{ opacity: pressed ? 0.75 : 1 }]}>
      <Card pad={14} style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
          {/* Thumbnail */}
          <View style={{ width: 80, height: 54, borderRadius: 10, backgroundColor: c.violet, justifyContent: 'center', alignItems: 'center', overflow: 'hidden', flexShrink: 0 }}>
            <T size={9} weight="800" style={{ color: '#fff', letterSpacing: 0.5, textTransform: 'uppercase' }}>{video.angle_label}</T>
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <T size={14} weight="700" color={c.ink}>{t('officialVideo.angle_label')}: {video.angle_label}</T>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {video.duration_ms ? <T size={11} color={c.mute}>{fmtDuration(video.duration_ms)}</T> : null}
              {video.file_size_bytes ? <T size={11} color={c.mute}>· {fmtBytes(video.file_size_bytes)}</T> : null}
            </View>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              <PurposeChip purpose={video.purpose} />
              {video.media_rights_clearance ? (
                <View style={{ backgroundColor: c.limeSoft, borderRadius: r.pill, paddingHorizontal: 7, paddingVertical: 2 }}>
                  <T size={10} weight="700" color={c.lime}>✓ {t('officialVideo.media_rights_ok')}</T>
                </View>
              ) : null}
              {video.youth_consent_required ? (
                <View style={{ backgroundColor: c.sunSoft, borderRadius: r.pill, paddingHorizontal: 7, paddingVertical: 2 }}>
                  <T size={10} weight="700" color={c.sun}>⚠ {t('officialVideo.youth_consent_required')}</T>
                </View>
              ) : null}
            </View>
          </View>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8, borderTopWidth: 1, borderColor: c.line }}>
          <T size={11} color={c.mute}>{video.uploader_name}</T>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {video.marker_count > 0 ? (
              <View style={{ backgroundColor: purposeSoft[video.purpose] ?? c.violetSoft, borderRadius: r.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
                <T size={10} weight="700" color={purposeColor[video.purpose] ?? c.mute}>{video.marker_count} {t('officialVideo.markers')}</T>
              </View>
            ) : null}
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

function MarkerRow({ marker }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.paper, borderRadius: 12, padding: 12, marginBottom: 6 }}>
      <View style={{ backgroundColor: c.violetSoft, borderRadius: r.pill, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 }}>
        <T size={11} weight="800" color={c.pink} style={{ fontVariant: ['tabular-nums'] }}>{fmtMs(marker.timestamp_ms)}</T>
      </View>
      <SeverityDot severity={marker.severity} />
      <View style={{ flex: 1, gap: 2 }}>
        <T size={13} weight="700" color={c.ink}>
          {marker.sport_event_code?.replace(/_/g, ' ') ?? marker.marker_type.replace(/_/g, ' ')}
        </T>
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <View style={{ backgroundColor: purposeSoft.match_record, borderRadius: r.pill, paddingHorizontal: 6, paddingVertical: 1 }}>
            <T size={10} weight="700" color={c.cyan}>{marker.marker_type}</T>
          </View>
          {marker.game_action_id ? <T size={10} color={c.mute}>→ action #{marker.game_action_id.slice(-6)}</T> : null}
          {marker.has_note ? <T size={10} color={c.mute}>📝 {t('officialVideo.note_encrypted')}</T> : null}
        </View>
      </View>
      <View style={{
        width: 24, height: 24, borderRadius: 12,
        borderWidth: 2, borderColor: marker.resolved_at ? c.lime : c.line,
        backgroundColor: marker.resolved_at ? c.limeSoft : 'transparent',
        justifyContent: 'center', alignItems: 'center',
      }}>
        {marker.resolved_at ? <T size={11} weight="700" color={c.lime}>✓</T> : null}
      </View>
    </View>
  );
}

function SessionCard({ session, onPress }) {
  return (
    <Pressable onPress={tapped(onPress)} style={({ pressed }) => [{ opacity: pressed ? 0.75 : 1 }]}>
      <Card pad={14} style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
          <T size={14} weight="700" color={c.ink} style={{ flex: 1 }}>
            {t(`officialVideo.review.type.${session.review_type}`) ?? session.review_type.replace(/_/g, ' ')}
          </T>
          <View style={{ backgroundColor: statusColor[session.status] ?? c.violetSoft, borderRadius: r.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
            <T size={10} weight="700" color={statusInk[session.status] ?? c.mute}>
              {t(`officialVideo.review.status.${session.status}`) ?? session.status}
            </T>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          {session.participant_count != null ? <T size={11} color={c.mute}>{session.participant_count} {t('officialVideo.participants')}</T> : null}
          {session.outcome_category ? <T size={11} color={c.mute}>· {t(`officialVideo.review.outcome.${session.outcome_category}`) ?? session.outcome_category}</T> : null}
          {session.appeal_deadline && session.status === 'concluded' ? (
            <T size={11} color={c.orange}>· {t('officialVideo.appeal_by')} {new Date(session.appeal_deadline).toLocaleDateString()}</T>
          ) : null}
        </View>
        {session.status === 'pending_evidence' ? (
          <View style={{ backgroundColor: c.sunSoft, borderRadius: 10, padding: 8 }}>
            <T size={11} weight="600" color={c.sun}>⏱ {t('officialVideo.review.pending_evidence_note')}</T>
          </View>
        ) : null}
      </Card>
    </Pressable>
  );
}

function ExportCard({ req, canApprove, onApprove, onReject }) {
  return (
    <Card pad={14} style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <T size={13} weight="700" color={c.ink} style={{ flex: 1 }}>{t('officialVideo.export.title')}</T>
        <View style={{ backgroundColor: exportStatusColor[req.status] ?? c.violetSoft, borderRadius: r.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
          <T size={10} weight="700" color={exportStatusInk[req.status] ?? c.mute}>
            {t(`officialVideo.export.status.${req.status}`) ?? req.status}
          </T>
        </View>
      </View>
      {req.recipient_org ? <T size={11} color={c.mute}>{t('officialVideo.export.recipient')}: {req.recipient_org}</T> : null}
      <T size={11} color={c.mute}>{t('officialVideo.export.downloads')}: {req.download_count}/{req.max_downloads}</T>
      {req.expires_at ? <T size={11} color={new Date() > new Date(req.expires_at) ? c.red : c.mute}>{t('officialVideo.export.expires')}: {new Date(req.expires_at).toLocaleDateString()}</T> : null}
      {canApprove && req.status === 'pending' ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
          <Pressable onPress={tapped(onApprove)} style={{ flex: 1, backgroundColor: c.pink, borderRadius: r.pill, paddingVertical: 8, alignItems: 'center' }}>
            <T size={12} weight="700" color="#fff">{t('officialVideo.export.approve')}</T>
          </Pressable>
          <Pressable onPress={tapped(onReject)} style={{ flex: 1, backgroundColor: c.redSoft, borderRadius: r.pill, paddingVertical: 8, alignItems: 'center' }}>
            <T size={12} weight="700" color={c.red}>{t('officialVideo.export.reject')}</T>
          </Pressable>
        </View>
      ) : null}
    </Card>
  );
}

// ─── TABS ────────────────────────────────────────────────────────────────────

const TABS = ['videos', 'incidents', 'reviews', 'exports'];

function TabStrip({ active, onChange }) {
  return (
    <View style={{ flexDirection: 'row', backgroundColor: c.paper, borderBottomWidth: 2, borderColor: c.line }}>
      {TABS.map((tab) => (
        <Pressable key={tab} onPress={tapped(() => onChange(tab))} style={{ flex: 1, paddingVertical: 10, alignItems: 'center', position: 'relative' }}>
          <T size={10} weight="700" color={active === tab ? c.pink : c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {t(`officialVideo.tab.${tab}`)}
          </T>
          {active === tab ? (
            <View style={{ position: 'absolute', bottom: -2, left: 0, right: 0, height: 2, backgroundColor: c.pink, borderRadius: 2 }} />
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

// ─── MAIN SCREEN ─────────────────────────────────────────────────────────────

export function OfficialVideoReview({ fixtureId }) {
  const { push } = useNav();
  const { toast } = useSession();
  const L = useLayout();
  const [activeTab, setActiveTab] = useState('videos');

  const videosLoad = useLoad(() => api.get(`/fixtures/${fixtureId}/match-videos`), [fixtureId]);
  const sessionsLoad = useLoad(() => api.get(`/fixtures/${fixtureId}/video-review-sessions`), [fixtureId]);

  const videos = videosLoad.data?.videos ?? [];
  const sessions = sessionsLoad.data?.sessions ?? [];

  const allMarkers = videos.flatMap((v) => []);

  // Marker tab requires video-level loads — handled lazily via navigate to player
  const markerCount = videos.reduce((s, v) => s + (v.marker_count ?? 0), 0);

  const exportLoad = useLoad(async () => {
    if (!videos.length) return { export_requests: [] };
    const all = await Promise.all(videos.map((v) => api.get(`/match-videos/${v.id}/export-requests`).catch(() => ({ export_requests: [] }))));
    return { export_requests: all.flatMap((r) => r.export_requests ?? []) };
  }, [videos.length]);
  const exports = exportLoad.data?.export_requests ?? [];

  const markerLoad = useLoad(async () => {
    if (!videos.length) return { markers: [] };
    const all = await Promise.all(videos.map((v) => api.get(`/match-videos/${v.id}/markers`).catch(() => ({ markers: [] }))));
    return { markers: all.flatMap((r, idx) => (r.markers ?? []).map((m) => ({ ...m, angle_label: videos[idx].angle_label }))) };
  }, [videos.length]);
  const markers = markerLoad.data?.markers ?? [];

  const handleUpload = () => toast(t('officialVideo.upload_via_app'));

  const handleOpenSession = async () => {
    try {
      const res = await api.post(`/fixtures/${fixtureId}/video-review-sessions`, { review_type: 'incident_review' });
      push('OfficialVideoPlayer', { fixtureId, sessionId: res.session.id });
    } catch (e) { toast(e.message); }
  };

  const loading = videosLoad.loading || sessionsLoad.loading;

  if (loading && !videos.length) return <Screen><Loading /></Screen>;

  const isTablet = L.width >= 768;

  return (
    <Screen>
      {/* Metric strip */}
      <MetricStrip videos={videos.length} markers={markerCount} sessions={sessions.length} exports={exports.length} />

      {isTablet ? (
        // Tablet: side-by-side list + detail
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ width: 300, borderRightWidth: 1, borderColor: c.line }}>
            <TabStrip active={activeTab} onChange={setActiveTab} />
            <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 12, gap: 10 }}>
              <TabContent tab={activeTab} videos={videos} markers={markers} sessions={sessions} exports={exports} push={push} toast={toast} fixtureId={fixtureId} />
            </ScrollView>
          </View>
          <View style={{ flex: 1, backgroundColor: c.bg, padding: 16, alignItems: 'center', justifyContent: videos.length ? undefined : 'center' }}>
            {videos.length ? (
              <VideoCard video={videos[0]} onPress={() => push('OfficialVideoPlayer', { fixtureId, videoId: videos[0].id })} />
            ) : (
              <Empty icon="🎬" title={t('officialVideo.empty.videos')} subtitle={t('officialVideo.empty.videos_sub')} />
            )}
          </View>
        </View>
      ) : (
        // Phone: stacked tabs
        <View style={{ flex: 1 }}>
          <TabStrip active={activeTab} onChange={setActiveTab} />
          <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 12, gap: 10, paddingBottom: 80 }}>
            <TabContent tab={activeTab} videos={videos} markers={markers} sessions={sessions} exports={exports} push={push} toast={toast} fixtureId={fixtureId} onOpenSession={handleOpenSession} />
          </ScrollView>
          {/* FAB */}
          <Pressable
            onPress={tapped(handleUpload)}
            style={{ position: 'absolute', bottom: 20, right: 16, width: 50, height: 50, borderRadius: 25, backgroundColor: c.pink, justifyContent: 'center', alignItems: 'center', shadowColor: c.pink, shadowOpacity: 0.5, shadowRadius: 8, shadowOffset: { width: 0, height: 4 }, elevation: 6 }}
            accessibilityLabel={t('officialVideo.upload')}
          >
            <T size={22} style={{ color: '#fff', marginTop: -2 }}>+</T>
          </Pressable>
        </View>
      )}
    </Screen>
  );
}

function TabContent({ tab, videos, markers, sessions, exports: exps, push, toast, fixtureId, onOpenSession }) {
  if (tab === 'videos') {
    if (!videos.length) return <Empty icon="🎬" title={t('officialVideo.empty.videos')} subtitle={t('officialVideo.empty.videos_sub')} />;
    return videos.map((v) => <VideoCard key={v.id} video={v} onPress={() => push('OfficialVideoPlayer', { fixtureId, videoId: v.id })} />);
  }

  if (tab === 'incidents') {
    if (!markers.length) return <Empty icon="📌" title={t('officialVideo.empty.incidents')} subtitle={t('officialVideo.empty.incidents_sub')} />;
    // Group by severity
    const bySeverity = { critical: [], high: [], medium: [], low: [] };
    for (const m of markers) (bySeverity[m.severity] ?? bySeverity.low).push(m);
    return Object.entries(bySeverity).filter(([, arr]) => arr.length > 0).map(([sev, arr]) => (
      <View key={sev}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 }}>
          <SeverityDot severity={sev} size={10} />
          <T size={11} weight="800" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
            {t(`officialVideo.severity.${sev}`)} ({arr.length})
          </T>
        </View>
        {arr.map((m) => <MarkerRow key={m.id} marker={m} />)}
      </View>
    ));
  }

  if (tab === 'reviews') {
    return (
      <View style={{ gap: 10 }}>
        {sessions.filter((s) => !['concluded', 'closed'].includes(s.status)).map((s) => (
          <SessionCard key={s.id} session={s} onPress={() => push('OfficialVideoPlayer', { fixtureId, sessionId: s.id })} />
        ))}
        {sessions.filter((s) => ['concluded', 'closed'].includes(s.status)).length > 0 ? (
          <View style={{ paddingVertical: 8 }}>
            <T size={11} weight="700" color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>{t('officialVideo.review.concluded')}</T>
            {sessions.filter((s) => ['concluded', 'closed'].includes(s.status)).map((s) => (
              <SessionCard key={s.id} session={s} onPress={() => push('OfficialVideoPlayer', { fixtureId, sessionId: s.id })} />
            ))}
          </View>
        ) : null}
        {!sessions.length ? <Empty icon="📋" title={t('officialVideo.empty.reviews')} subtitle={t('officialVideo.empty.reviews_sub')} /> : null}
        <Pressable onPress={tapped(onOpenSession)} style={{ backgroundColor: c.pink, borderRadius: r.pill, padding: 14, alignItems: 'center', marginTop: 8 }}>
          <T size={13} weight="700" color="#fff">+ {t('officialVideo.review.open_cta')}</T>
        </Pressable>
      </View>
    );
  }

  if (tab === 'exports') {
    if (!exps.length) return <Empty icon="📤" title={t('officialVideo.empty.exports')} subtitle={t('officialVideo.empty.exports_sub')} />;
    return (
      <View style={{ gap: 10 }}>
        <T size={12} color={c.mute}>{t('officialVideo.export.policy_note')}</T>
        {exps.map((e) => <ExportCard key={e.id} req={e} canApprove />)}
      </View>
    );
  }
  return null;
}
