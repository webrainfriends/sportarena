// Video Intelligence workspace — issue #581.
// Extends the skeleton from #318: adds annotation CRUD, tactical categories, AI tag panel,
// assignment workflow, clip comparison entry point, and tactical board linkage.
// All text decrypted server-side; AI annotations always show inference_label.
import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, Platform,
  ActivityIndicator, Dimensions,
} from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { c } from '../theme';
import { t } from '../i18n';
import { Btn, Card, T } from '../ui';

const TACTICAL_CATS = [
  'attacking','defending','set_piece','transition','pressing','shape',
  'individual_error','individual_excellence','fitness','other',
];
const CAT_COLOR = {
  attacking: '#E63946', defending: '#457B9D', set_piece: '#8338EC',
  transition: '#FB8500', pressing: '#06D6A0', shape: '#118AB2',
  individual_error: '#EF233C', individual_excellence: '#52B788',
  fitness: '#7B2D8B', other: '#6B7280',
};

function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ── Annotation Row ────────────────────────────────────────────────────────────
function AnnotationRow({ ann, currentMs, onSeek, onReply, onResolve }) {
  const active = Math.abs((ann.timestamp_ms || 0) - currentMs) < 3000;
  const catColor = ann.tactical_category ? CAT_COLOR[ann.tactical_category] : c.pink;
  return (
    <TouchableOpacity
      onPress={() => onSeek(ann.timestamp_ms)}
      accessibilityRole="button"
      accessibilityLabel={`${t('va.annotation')} ${formatMs(ann.timestamp_ms)} ${ann.author_name}`}
      style={[styles.annRow, active && { backgroundColor: c.pinkTint }, { borderBottomColor: c.line }]}
    >
      <View style={[styles.tsChip, { backgroundColor: c.pinkTint }]}>
        <T weight="800" size={11} style={{ color: c.pink }}>{formatMs(ann.timestamp_ms)}</T>
        {ann.end_timestamp_ms ? <T weight="600" size={10} style={{ color: c.mute }}>→{formatMs(ann.end_timestamp_ms)}</T> : null}
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.annHeader}>
          <T weight="700" size={12}>{ann.author_name}</T>
          {ann.tactical_category ? (
            <View style={[styles.catChip, { backgroundColor: catColor + '22', borderColor: catColor + '55' }]}>
              <T size={10} style={{ color: catColor, fontWeight: '700' }}>{ann.tactical_category.replace(/_/g, ' ').toUpperCase()}</T>
            </View>
          ) : null}
          {ann.ai_generated ? (
            <View style={[styles.catChip, { backgroundColor: '#F0E6FF', borderColor: '#8458B366' }]}>
              <T size={10} style={{ color: '#8458B3', fontWeight: '700' }}>AI</T>
            </View>
          ) : null}
          <View style={[styles.statusDot, { backgroundColor: ann.resolved_at ? c.lime : c.sun }]} />
          <T size={11} color={c.mute}>{ann.resolved_at ? t('va.resolved') : t('va.open')}</T>
        </View>
        {ann.ai_inference_label ? (
          <T size={10} color={c.mute} style={{ marginTop: 1, fontStyle: 'italic' }}>{ann.ai_inference_label}</T>
        ) : null}
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

// ── Add Annotation Sheet ──────────────────────────────────────────────────────
function AddAnnotationSheet({ videoId, currentMs, onAdded, onClose }) {
  const [text, setText] = useState('');
  const [cat, setCat] = useState(null);
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await api.post(`/me/videos/${videoId}/annotations`, {
        timestamp_ms: currentMs,
        text,
        tactical_category: cat || undefined,
      });
      onAdded();
    } finally { setSaving(false); }
  }, [videoId, currentMs, text, cat, onAdded]);

  return (
    <View style={[styles.sheet, { backgroundColor: c.paper, borderTopColor: c.line }]}>
      <View style={styles.sheetHeader}>
        <T weight="700" size={14}>{t('va.add_annotation')} @ {formatMs(currentMs)}</T>
        <TouchableOpacity onPress={onClose} accessibilityRole="button" hitSlop={12}>
          <T size={16} color={c.mute}>✕</T>
        </TouchableOpacity>
      </View>
      <T size={11} color={c.mute} style={{ marginBottom: 6 }}>{t('va.tactical_category')}</T>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {TACTICAL_CATS.map((c2) => (
            <TouchableOpacity
              key={c2}
              onPress={() => setCat(cat === c2 ? null : c2)}
              style={[styles.catBtn, cat === c2 && { backgroundColor: (CAT_COLOR[c2] || c.pink), borderColor: CAT_COLOR[c2] || c.pink }]}
              accessibilityRole="button"
              accessibilityLabel={c2.replace(/_/g, ' ')}
            >
              <T size={11} style={{ color: cat === c2 ? '#fff' : (CAT_COLOR[c2] || c.pink), fontWeight: '700' }}>
                {c2.replace(/_/g, ' ')}
              </T>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
      <TextInput
        style={[styles.replyInput, { backgroundColor: c.bg, color: c.ink, borderColor: c.line }]}
        value={text}
        onChangeText={setText}
        placeholder={t('va.add_note')}
        placeholderTextColor={c.mute}
        multiline
        maxLength={4000}
        accessibilityLabel={t('va.add_annotation')}
      />
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
        <Btn title={t('va.add_annotation')} onPress={save} loading={saving} />
      </View>
    </View>
  );
}

// ── AI Tags Panel ─────────────────────────────────────────────────────────────
function AITagsPanel({ videoId }) {
  const tags = useLoad(() => api.get(`/me/videos/${videoId}/ai-tags`, { status: 'pending' }), [videoId]);
  const [generating, setGenerating] = useState(false);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      await api.post(`/me/videos/${videoId}/ai-summary`);
      tags.reload();
    } finally { setGenerating(false); }
  }, [videoId, tags]);

  const confirm = useCallback(async (tagId) => {
    await api.post(`/video-ai-tags/${tagId}/confirm`);
    tags.reload();
  }, [tags]);

  const reject = useCallback(async (tagId) => {
    await api.post(`/video-ai-tags/${tagId}/reject`);
    tags.reload();
  }, [tags]);

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.controls, { backgroundColor: c.paper, borderBottomColor: c.line }]}>
        <T weight="700" size={13} color={c.mute}>{t('va.ai_tags')} ({(tags.data || []).length})</T>
        <TouchableOpacity onPress={generate} disabled={generating} accessibilityRole="button">
          {generating
            ? <ActivityIndicator color={c.pink} />
            : <T size={12} style={{ color: c.pink, fontWeight: '700' }}>{t('va.generate_summary')}</T>}
        </TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {tags.loading && <ActivityIndicator color={c.pink} style={{ margin: 24 }} />}
        {!tags.loading && !(tags.data || []).length && (
          <View style={{ padding: 32, alignItems: 'center' }}>
            <T size={28}>🤖</T>
            <T size={14} color={c.mute} style={{ marginTop: 8, textAlign: 'center' }}>{t('va.ai_suggestion')}</T>
          </View>
        )}
        {(tags.data || []).map((tag) => (
          <View key={tag.id} style={[styles.annRow, { borderBottomColor: c.line, flexDirection: 'column', gap: 6 }]}>
            <T size={10} color={c.mute} style={{ fontStyle: 'italic' }}>{tag.inference_label}</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={[styles.catChip, { backgroundColor: '#F0E6FF', borderColor: '#8458B366' }]}>
                <T size={11} style={{ color: '#8458B3', fontWeight: '700' }}>{tag.tag_key}</T>
              </View>
              <T weight="700" size={13}>{tag.tag_value.replace(/_/g, ' ')}</T>
              {tag.confidence ? <T size={11} color={c.mute}>{Math.round(tag.confidence * 100)}%</T> : null}
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity onPress={() => confirm(tag.id)} style={[styles.catBtn, { backgroundColor: c.lime + '22', borderColor: c.lime }]} accessibilityRole="button">
                <T size={12} style={{ color: c.lime, fontWeight: '700' }}>{t('va.confirm_tag')}</T>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => reject(tag.id)} style={[styles.catBtn, { borderColor: c.mute }]} accessibilityRole="button">
                <T size={12} color={c.mute} style={{ fontWeight: '700' }}>{t('va.reject_tag')}</T>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

// ── Assignments Panel ─────────────────────────────────────────────────────────
function AssignmentsPanel({ videoId }) {
  const assigns = useLoad(() => api.get(`/me/videos/${videoId}/assignments`), [videoId]);
  const STATUS_COLOR = { sent: c.sun, seen: c.cyan, acknowledged: c.lime, responded: '#52B788', dismissed: c.mute };

  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.controls, { backgroundColor: c.paper, borderBottomColor: c.line }]}>
        <T weight="700" size={13} color={c.mute}>{t('va.assignments')} ({(assigns.data || []).length})</T>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {assigns.loading && <ActivityIndicator color={c.pink} style={{ margin: 24 }} />}
        {!assigns.loading && !(assigns.data || []).length && (
          <View style={{ padding: 32, alignItems: 'center' }}>
            <T size={28}>📋</T>
            <T size={14} color={c.mute} style={{ marginTop: 8, textAlign: 'center' }}>{t('va.assign_to_athlete')}</T>
          </View>
        )}
        {(assigns.data || []).map((a) => (
          <View key={a.id} style={[styles.annRow, { borderBottomColor: c.line }]}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <T weight="700" size={13}>{a.athlete_name}</T>
                <View style={[styles.statusDot, { backgroundColor: STATUS_COLOR[a.status] || c.mute }]} />
                <T size={11} color={c.mute}>{t(`va.${a.status === 'acknowledged' ? 'acknowledged' : a.status === 'responded' ? 'responded' : 'pending_response'}`)}</T>
              </View>
              {a.context_start_ms != null ? (
                <T size={11} color={c.mute} style={{ marginTop: 2 }}>
                  {formatMs(a.context_start_ms)}{a.context_end_ms ? ` → ${formatMs(a.context_end_ms)}` : ''}
                  {a.tactical_category ? ` · ${a.tactical_category.replace(/_/g, ' ')}` : ''}
                </T>
              ) : null}
              {a.message ? <T size={12} color={c.mute} style={{ marginTop: 4 }} numberOfLines={2}>{a.message}</T> : null}
              {a.athlete_response ? (
                <View style={[styles.replyBubble, { backgroundColor: c.pinkTint, marginTop: 6 }]}>
                  <T size={11} weight="700" color={c.pink}>Athlete: </T>
                  <T size={12} color={c.ink} numberOfLines={3}>{a.athlete_response}</T>
                </View>
              ) : null}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export function VideoAnalysisScreen({ route }) {
  const { videoId, videoTitle } = route?.params || {};
  const [currentMs, setCurrentMs] = useState(0);
  const [replyTarget, setReplyTarget] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [exporting, setExporting] = useState(false);
  const [showAddAnn, setShowAddAnn] = useState(false);
  const [tab, setTab] = useState('annotations'); // annotations | ai_tags | assignments
  const [catFilter, setCatFilter] = useState(null);
  const { push } = useNav();

  const anns = useLoad(
    () => api.get(`/me/videos/${videoId}/annotations`, catFilter ? { tactical_category: catFilter } : {}),
    [videoId, catFilter],
  );

  const handleResolve = useCallback(async (ann) => {
    await api.post(`/me/videos/${videoId}/annotations/${ann.id}/resolve`, { resolved: true });
    anns.reload();
  }, [videoId, anns]);

  const handleReply = useCallback(async () => {
    if (!replyText.trim() || !replyTarget) return;
    await api.post(`/me/videos/${videoId}/annotations/${replyTarget.id}/reply`, { text: replyText });
    setReplyText(''); setReplyTarget(null); anns.reload();
  }, [videoId, replyTarget, replyText, anns]);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try { await api.get(`/me/videos/${videoId}/analysis/export`); }
    finally { setExporting(false); }
  }, [videoId]);

  const handleOpenComparison = useCallback(() => {
    push('ClipComparison', { videoAId: videoId, videoATitle: videoTitle });
  }, [push, videoId, videoTitle]);

  const handleOpenBoard = useCallback(() => {
    push('TacticalBoard', {});
  }, [push]);

  const { width } = Dimensions.get('window');
  const isWide = width >= 768;

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      {/* Video player area */}
      <View style={[styles.playerArea, { backgroundColor: '#1a1a2e' }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingTop: 8 }}>
          <T size={12} style={{ color: 'rgba(255,255,255,.7)', fontWeight: '600', flex: 1 }} numberOfLines={1}>{videoTitle}</T>
          <TouchableOpacity onPress={handleOpenComparison} accessibilityRole="button" style={{ marginStart: 8 }}>
            <T size={11} style={{ color: 'rgba(255,255,255,.6)' }}>{t('va.comparison')} ›</T>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleOpenBoard} accessibilityRole="button" style={{ marginStart: 8 }}>
            <T size={11} style={{ color: 'rgba(255,255,255,.6)' }}>{t('va.board')} ›</T>
          </TouchableOpacity>
        </View>
        <View style={styles.playerCenter}>
          <View style={styles.bigPlay} accessibilityRole="button" accessibilityLabel={t('va.play')}>
            <T size={22} style={{ color: '#fff', marginLeft: 4 }}>▶</T>
          </View>
        </View>
        {/* Timeline with color-coded annotation pins */}
        <View style={styles.timeline}>
          <View style={[styles.track, { backgroundColor: 'rgba(255,255,255,.18)' }]}>
            <View style={[styles.fill, { backgroundColor: c.pink, width: '35%' }]} />
            {(anns.data || []).map((ann) => {
              const pinColor = ann.tactical_category ? CAT_COLOR[ann.tactical_category] : c.pink;
              return (
                <TouchableOpacity
                  key={ann.id}
                  style={[styles.pin, { left: `${Math.min((ann.timestamp_ms / 198000) * 100, 99)}%`, backgroundColor: pinColor }]}
                  onPress={() => setCurrentMs(ann.timestamp_ms)}
                  accessibilityRole="button"
                />
              );
            })}
          </View>
          <T size={11} style={{ color: 'rgba(255,255,255,.6)', marginTop: 4 }}>
            {formatMs(currentMs)} / 3:18
          </T>
        </View>
      </View>

      {/* Tab bar */}
      <View style={[styles.tabBar, { backgroundColor: c.paper, borderBottomColor: c.line }]}>
        {['annotations', 'ai_tags', 'assignments'].map((tk) => (
          <TouchableOpacity
            key={tk}
            onPress={() => setTab(tk)}
            style={[styles.tabBtn, tab === tk && styles.tabBtnActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === tk }}
          >
            <T size={12} weight={tab === tk ? '700' : '500'} style={{ color: tab === tk ? c.pink : c.mute }}>
              {t(`va.${tk === 'annotations' ? 'annotation' : tk}`)}
            </T>
          </TouchableOpacity>
        ))}
        {/* Export + Add actions */}
        <View style={{ flex: 1 }} />
        <TouchableOpacity onPress={handleExport} disabled={exporting} style={{ padding: 8 }} accessibilityRole="button">
          {exporting ? <ActivityIndicator color={c.pink} size="small" /> : <T size={12} style={{ color: c.pink, fontWeight: '700' }}>{t('va.export')}</T>}
        </TouchableOpacity>
        {tab === 'annotations' && (
          <TouchableOpacity onPress={() => setShowAddAnn(true)} style={{ padding: 8 }} accessibilityRole="button">
            <T size={18} style={{ color: c.pink, lineHeight: 20 }}>+</T>
          </TouchableOpacity>
        )}
      </View>

      {/* Category filter chips (annotations tab) */}
      {tab === 'annotations' && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.catScroll, { backgroundColor: c.paper, borderBottomColor: c.line }]} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 6, gap: 6 }}>
          <TouchableOpacity onPress={() => setCatFilter(null)} style={[styles.catBtn, !catFilter && styles.catBtnActive]} accessibilityRole="button">
            <T size={11} style={{ color: !catFilter ? '#fff' : c.mute, fontWeight: '700' }}>All</T>
          </TouchableOpacity>
          {TACTICAL_CATS.map((ct) => (
            <TouchableOpacity
              key={ct}
              onPress={() => setCatFilter(catFilter === ct ? null : ct)}
              style={[styles.catBtn, catFilter === ct && { backgroundColor: CAT_COLOR[ct], borderColor: CAT_COLOR[ct] }]}
              accessibilityRole="button"
            >
              <T size={11} style={{ color: catFilter === ct ? '#fff' : (CAT_COLOR[ct] || c.mute), fontWeight: '700' }}>
                {ct.replace(/_/g, ' ')}
              </T>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Panel content */}
      {tab === 'annotations' && (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 32 }}>
          {anns.loading && <ActivityIndicator color={c.pink} style={{ margin: 24 }} />}
          {!anns.loading && (anns.data || []).length === 0 && (
            <View style={{ padding: 32, alignItems: 'center' }}>
              <T size={32}>🎬</T>
              <T size={14} color={c.mute} style={{ marginTop: 8, textAlign: 'center' }}>{t('va.empty')}</T>
            </View>
          )}
          {(anns.data || []).map((ann) => (
            <AnnotationRow key={ann.id} ann={ann} currentMs={currentMs} onSeek={setCurrentMs} onReply={setReplyTarget} onResolve={handleResolve} />
          ))}
        </ScrollView>
      )}
      {tab === 'ai_tags' && <AITagsPanel videoId={videoId} />}
      {tab === 'assignments' && <AssignmentsPanel videoId={videoId} />}

      {/* Add annotation sheet */}
      {showAddAnn && (
        <AddAnnotationSheet
          videoId={videoId}
          currentMs={currentMs}
          onAdded={() => { setShowAddAnn(false); anns.reload(); }}
          onClose={() => setShowAddAnn(false)}
        />
      )}

      {/* Reply sheet */}
      {replyTarget && (
        <View style={[styles.sheet, { backgroundColor: c.paper, borderTopColor: c.line }]}>
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
  tabBar: {
    flexDirection: 'row', alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 4,
  },
  tabBtn: { paddingHorizontal: 10, paddingVertical: 10 },
  tabBtnActive: { borderBottomWidth: 2, borderBottomColor: '#8458B3' },
  catScroll: { borderBottomWidth: StyleSheet.hairlineWidth, flexGrow: 0 },
  catBtn: {
    borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4,
    borderWidth: 1, borderColor: c.line,
  },
  catBtnActive: { backgroundColor: c.pink, borderColor: c.pink },
  catChip: {
    borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2,
    borderWidth: 1,
  },
  controls: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  annRow: {
    flexDirection: 'row', gap: 10, padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tsChip: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, alignSelf: 'flex-start', marginTop: 2 },
  annHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  annActions: { flexDirection: 'row', marginTop: 6 },
  replyBubble: { borderRadius: 8, padding: 8, flexDirection: 'row', flexWrap: 'wrap' },
  sheet: {
    padding: 16, borderTopWidth: 1,
    ...Platform.select({ ios: { paddingBottom: 32 }, android: { paddingBottom: 16 }, default: {} }),
  },
  sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  replyInput: {
    flex: 1, borderWidth: 1, borderRadius: 10,
    padding: 10, fontSize: 14, maxHeight: 80,
  },
});
