// Clip Comparison — issue #581. Side-by-side clip comparison with sync mode.
// Phone: stacked panels. Tablet/desktop: side-by-side. Each panel has its own annotation pins.
import React, { useState, useCallback, useRef } from 'react';
import {
  View, ScrollView, TouchableOpacity, TextInput, StyleSheet, Platform,
  Dimensions, Switch, ActivityIndicator,
} from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { c } from '../theme';
import { t } from '../i18n';
import { Btn, Card, T } from '../ui';

function formatMs(ms) {
  const s = Math.floor((ms || 0) / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ── Single clip panel ─────────────────────────────────────────────────────────
function ClipPanel({ videoId, videoTitle, startMs = 0, endMs, currentMs, onTimeChange, syncMode, label }) {
  const anns = useLoad(() => videoId ? api.get(`/me/videos/${videoId}/annotations`) : null, [videoId]);
  const duration = endMs ? endMs - startMs : 198000;
  const relativeMs = currentMs - startMs;

  return (
    <View style={[styles.clipPanel, { backgroundColor: '#1a1a2e' }]}>
      {/* Video area */}
      <View style={styles.videoArea}>
        <View style={styles.labelBadge}>
          <T size={11} style={{ color: '#fff', fontWeight: '700' }}>{label}</T>
        </View>
        <T size={12} style={{ color: 'rgba(255,255,255,.7)', paddingHorizontal: 10, paddingTop: 2 }} numberOfLines={1}>{videoTitle || '—'}</T>
        <View style={styles.playerCenter}>
          <View style={styles.bigPlay} accessibilityRole="button" accessibilityLabel={t('va.play')}>
            <T size={18} style={{ color: '#fff', marginLeft: 3 }}>▶</T>
          </View>
        </View>
        {/* Timeline */}
        <View style={styles.timeline}>
          <View style={[styles.track, { backgroundColor: 'rgba(255,255,255,.18)' }]}>
            <View style={[styles.fill, { backgroundColor: c.pink, width: `${Math.min((relativeMs / duration) * 100, 100)}%` }]} />
            {(anns.data || []).map((ann) => (
              <View
                key={ann.id}
                style={[styles.pin, {
                  left: `${Math.min(((ann.timestamp_ms - startMs) / duration) * 100, 99)}%`,
                  backgroundColor: c.pink,
                }]}
              />
            ))}
          </View>
          <T size={11} style={{ color: 'rgba(255,255,255,.6)', marginTop: 4 }}>
            {formatMs(relativeMs)} / {formatMs(duration)}
          </T>
        </View>
      </View>
      {/* Annotations */}
      <ScrollView style={{ maxHeight: 140 }}>
        {anns.loading && <ActivityIndicator color={c.pink} style={{ margin: 8 }} />}
        {(anns.data || []).slice(0, 5).map((ann) => (
          <View key={ann.id} style={[styles.annRow, { borderBottomColor: c.line }]}>
            <View style={[styles.tsChip, { backgroundColor: c.pinkTint }]}>
              <T weight="800" size={10} style={{ color: c.pink }}>{formatMs(ann.timestamp_ms)}</T>
            </View>
            <T size={11} color={c.mute} numberOfLines={2} style={{ flex: 1 }}>{ann.text || (ann.has_drawing ? '🖊 drawing' : '')}</T>
          </View>
        ))}
        {(anns.data || []).length > 5 && (
          <T size={11} color={c.mute} style={{ padding: 6, textAlign: 'center' }}>+{(anns.data || []).length - 5} more</T>
        )}
      </ScrollView>
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export function ClipComparisonScreen({ route }) {
  const { videoAId, videoATitle, videoBId, videoBTitle, comparisonId } = route?.params || {};

  const existing = useLoad(() => comparisonId ? api.get(`/video-comparisons/${comparisonId}`) : null, [comparisonId]);

  const [videoA, setVideoA] = useState({ id: videoAId, title: videoATitle, startMs: 0, endMs: null });
  const [videoB, setVideoB] = useState({ id: videoBId, title: videoBTitle, startMs: 0, endMs: null });
  const [syncMode, setSyncMode] = useState(false);
  const [currentMsA, setCurrentMsA] = useState(0);
  const [currentMsB, setCurrentMsB] = useState(0);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const { width } = Dimensions.get('window');
  const isWide = width >= 768;

  const handleTimeA = useCallback((ms) => {
    setCurrentMsA(ms);
    if (syncMode) setCurrentMsB(ms);
  }, [syncMode]);

  const handleTimeB = useCallback((ms) => {
    setCurrentMsB(ms);
    if (syncMode) setCurrentMsA(ms);
  }, [syncMode]);

  const handleSave = useCallback(async () => {
    if (!videoA.id || !videoB.id) return;
    setSaving(true);
    try {
      await api.post('/video-comparisons', {
        title: `${videoA.title || 'Clip A'} vs ${videoB.title || 'Clip B'}`,
        video_a_id: videoA.id, start_ms_a: videoA.startMs, end_ms_a: videoA.endMs,
        video_b_id: videoB.id, start_ms_b: videoB.startMs, end_ms_b: videoB.endMs,
        notes: notes || undefined,
      });
      setSaved(true);
    } finally { setSaving(false); }
  }, [videoA, videoB, notes]);

  const panels = (
    <>
      <ClipPanel
        videoId={videoA.id}
        videoTitle={videoA.title}
        startMs={videoA.startMs}
        endMs={videoA.endMs}
        currentMs={currentMsA}
        onTimeChange={handleTimeA}
        syncMode={syncMode}
        label="A"
      />
      <ClipPanel
        videoId={videoB.id}
        videoTitle={videoB.title}
        startMs={videoB.startMs}
        endMs={videoB.endMs}
        currentMs={currentMsB}
        onTimeChange={handleTimeB}
        syncMode={syncMode}
        label="B"
      />
    </>
  );

  return (
    <ScrollView style={[styles.screen, { backgroundColor: c.bg }]} contentContainerStyle={{ paddingBottom: 32 }}>
      {/* Sync toggle */}
      <View style={[styles.syncBar, { backgroundColor: c.paper, borderBottomColor: c.line }]}>
        <T size={13} weight="600">{t('va.comparison')}</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T size={12} color={c.mute}>{t('va.sync_mode')}</T>
          <Switch
            value={syncMode}
            onValueChange={setSyncMode}
            trackColor={{ false: c.line, true: c.pink }}
            thumbColor="#fff"
            accessibilityLabel={t('va.sync_mode')}
          />
        </View>
      </View>

      {/* Clip panels */}
      <View style={[styles.panelsRow, isWide && styles.panelsRowWide]}>
        {panels}
      </View>

      {/* Notes */}
      <View style={{ padding: 16 }}>
        <T size={12} color={c.mute} style={{ marginBottom: 4 }}>Comparison notes</T>
        <TextInput
          style={[styles.notesInput, { backgroundColor: c.paper, color: c.ink, borderColor: c.line }]}
          value={notes}
          onChangeText={setNotes}
          placeholder="Observations, tactical differences..."
          placeholderTextColor={c.mute}
          multiline
          maxLength={4000}
          accessibilityLabel="Comparison notes"
        />
        <Btn
          title={saved ? '✓ Saved' : t('va.comparison')}
          onPress={handleSave}
          loading={saving}
          disabled={saved || !videoA.id || !videoB.id}
          style={{ marginTop: 10, alignSelf: 'flex-start' }}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  syncBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  panelsRow: { flexDirection: 'column' },
  panelsRowWide: { flexDirection: 'row' },
  clipPanel: { flex: 1 },
  videoArea: {},
  labelBadge: {
    position: 'absolute', top: 6, right: 8, zIndex: 2,
    backgroundColor: 'rgba(0,0,0,.55)', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3,
  },
  playerCenter: { alignItems: 'center', paddingVertical: 20 },
  bigPlay: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,.18)',
    borderWidth: 2, borderColor: 'rgba(255,255,255,.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  timeline: { paddingHorizontal: 10, paddingBottom: 8 },
  track: { height: 4, borderRadius: 2, position: 'relative', overflow: 'visible' },
  fill: { height: '100%', borderRadius: 2 },
  pin: { position: 'absolute', top: -5, width: 4, height: 14, borderRadius: 2 },
  annRow: {
    flexDirection: 'row', gap: 8, paddingHorizontal: 10, paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tsChip: { borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2, alignSelf: 'flex-start' },
  notesInput: {
    borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 14,
    minHeight: 80, maxHeight: 160,
  },
});
