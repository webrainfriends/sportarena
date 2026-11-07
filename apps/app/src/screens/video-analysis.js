// Timestamped video analysis screen (#318). Coach/staff add timestamped annotations; athletes reply and export feedback as PDF.
// All annotation text is decrypted server-side before this screen receives it; no raw ciphertext displayed.
import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, Platform, ActivityIndicator } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { c } from '../theme';
import { t } from '../i18n';
import { Btn, Card, T } from '../ui';

function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function AnnotationRow({ ann, currentMs, onSeek, onReply, onResolve }) {
  const active = Math.abs((ann.timestamp_ms || 0) - currentMs) < 3000;
  return (
    <TouchableOpacity
      onPress={() => onSeek(ann.timestamp_ms)}
      accessibilityRole="button"
      accessibilityLabel={`${t('va.annotation')} ${formatMs(ann.timestamp_ms)} ${ann.author_name}`}
      style={[styles.annRow, active && { backgroundColor: c.pinkTint }, { borderBottomColor: c.line }]}
    >
      <View style={[styles.tsChip, { backgroundColor: c.pinkTint }]}>
        <T weight="800" size={11} style={{ color: c.pink }}>{formatMs(ann.timestamp_ms)}</T>
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.annHeader}>
          <T weight="700" size={12}>{ann.author_name}</T>
          <View style={[styles.statusDot, { backgroundColor: ann.resolved_at ? c.lime : c.sun }]} />
          <T size={11} color={c.mute}>{ann.resolved_at ? t('va.resolved') : t('va.open')}</T>
        </View>
        {ann.text ? <T size={12} color={c.mute} style={{ marginTop: 2 }} numberOfLines={3}>{ann.text}</T> : null}
        {ann.has_drawing ? <T size={11} color={c.mute} style={{ marginTop: 2 }}>🖊 {t('va.drawing')}</T> : null}
        <View style={styles.annActions}>
          <TouchableOpacity onPress={() => onReply(ann)} accessibilityRole="button">
            <T size={12} style={{ color: c.pink, fontWeight: '600' }}>
              {t('va.reply')}{ann.reply_count > 0 ? ` (${ann.reply_count})` : ''}
            </T>
          </TouchableOpacity>
          {!ann.resolved_at && (
            <TouchableOpacity onPress={() => onResolve(ann)} accessibilityRole="button" style={{ marginStart: 12 }}>
              <T size={12} color={c.mute}>{t('va.resolve')}</T>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

export function VideoAnalysisScreen({ route }) {
  const { videoId, videoTitle } = route?.params || {};
  const [currentMs, setCurrentMs] = useState(0);
  const [replyTarget, setReplyTarget] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [exporting, setExporting] = useState(false);
  const { pop } = useNav();

  const anns = useLoad(() => api.get(`/me/videos/${videoId}/annotations`), [videoId]);

  const handleResolve = useCallback(async (ann) => {
    await api.post(`/me/videos/${videoId}/annotations/${ann.id}/resolve`, { resolved: true });
    anns.reload();
  }, [videoId, anns]);

  const handleReply = useCallback(async () => {
    if (!replyText.trim() || !replyTarget) return;
    await api.post(`/me/videos/${videoId}/annotations/${replyTarget.id}/reply`, { text: replyText });
    setReplyText('');
    setReplyTarget(null);
    anns.reload();
  }, [videoId, replyTarget, replyText, anns]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try { await api.get(`/me/videos/${videoId}/analysis/export`); }
    finally { setExporting(false); }
  }, [videoId]);

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      {/* Video player area */}
      <View style={[styles.playerArea, { backgroundColor: '#1a1a2e' }]}>
        <T size={12} style={{ color: 'rgba(255,255,255,.7)', padding: 10, fontWeight: '600' }} numberOfLines={1}>{videoTitle}</T>
        <View style={styles.playerCenter}>
          <View style={styles.bigPlay} accessibilityRole="button" accessibilityLabel={t('va.play')}>
            <T size={22} style={{ color: '#fff', marginLeft: 4 }}>▶</T>
          </View>
        </View>
        {/* Annotation pins on timeline */}
        <View style={styles.timeline}>
          <View style={[styles.track, { backgroundColor: 'rgba(255,255,255,.18)' }]}>
            <View style={[styles.fill, { backgroundColor: c.pink, width: '35%' }]} />
            {(anns.data || []).map((ann) => (
              <TouchableOpacity
                key={ann.id}
                style={[styles.pin, { left: `${Math.min((ann.timestamp_ms / 198000) * 100, 99)}%`, backgroundColor: c.pink }]}
                onPress={() => setCurrentMs(ann.timestamp_ms)}
              />
            ))}
          </View>
          <T size={11} style={{ color: 'rgba(255,255,255,.6)', marginTop: 4 }}>1:08 / 3:18</T>
        </View>
      </View>

      {/* Controls bar */}
      <View style={[styles.controls, { backgroundColor: c.paper, borderBottomColor: c.line }]}>
        <T weight="700" size={13} color={c.mute}>
          {t('va.annotation')} ({(anns.data || []).length})
        </T>
        <TouchableOpacity onPress={handleExport} disabled={exporting} accessibilityRole="button">
          {exporting
            ? <ActivityIndicator color={c.pink} />
            : <T size={13} style={{ color: c.pink, fontWeight: '700' }}>{t('va.export')}</T>
          }
        </TouchableOpacity>
      </View>

      {/* Annotations */}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 32 }}>
        {anns.loading && <ActivityIndicator color={c.pink} style={{ margin: 24 }} />}
        {!anns.loading && (anns.data || []).length === 0 && (
          <View style={{ padding: 32, alignItems: 'center' }}>
            <T size={32}>🎬</T>
            <T size={14} color={c.mute} style={{ marginTop: 8, textAlign: 'center' }}>{t('va.empty')}</T>
          </View>
        )}
        {(anns.data || []).map((ann) => (
          <AnnotationRow
            key={ann.id}
            ann={ann}
            currentMs={currentMs}
            onSeek={setCurrentMs}
            onReply={setReplyTarget}
            onResolve={handleResolve}
          />
        ))}
      </ScrollView>

      {/* Reply sheet */}
      {replyTarget && (
        <View style={[styles.replySheet, { backgroundColor: c.paper, borderTopColor: c.line }]}>
          <T size={12} color={c.mute} style={{ marginBottom: 8 }}>
            {t('va.reply')} → {replyTarget.author_name}
          </T>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
            <TextInput
              style={[styles.replyInput, { backgroundColor: c.bg, color: c.ink, borderColor: c.line }]}
              value={replyText}
              onChangeText={setReplyText}
              placeholder={t('va.add_note')}
              placeholderTextColor={c.mute}
              multiline
              maxLength={2000}
              accessibilityLabel={t('va.add_note')}
            />
            <Btn title={t('va.reply')} onPress={handleReply} small />
          </View>
          <TouchableOpacity onPress={() => { setReplyTarget(null); setReplyText(''); }} style={{ marginTop: 8 }}>
            <T size={12} color={c.mute} style={{ textAlign: 'right' }}>Cancel</T>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  playerArea: {},
  playerCenter: { alignItems: 'center', paddingVertical: 24 },
  bigPlay: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,.18)',
    borderWidth: 2, borderColor: 'rgba(255,255,255,.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  timeline: { paddingHorizontal: 12, paddingBottom: 10 },
  track: { height: 4, borderRadius: 2, position: 'relative', overflow: 'visible' },
  fill: { height: '100%', borderRadius: 2 },
  pin: { position: 'absolute', top: -5, width: 4, height: 14, borderRadius: 2 },
  controls: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  annRow: {
    flexDirection: 'row', gap: 10, padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tsChip: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, alignSelf: 'flex-start', marginTop: 2 },
  annHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  annActions: { flexDirection: 'row', marginTop: 6 },
  replySheet: {
    padding: 16, borderTopWidth: 1,
    ...Platform.select({ ios: { paddingBottom: 32 }, android: { paddingBottom: 16 }, default: {} }),
  },
  replyInput: {
    flex: 1, borderWidth: 1, borderRadius: 10,
    padding: 10, fontSize: 14, maxHeight: 80,
  },
});
