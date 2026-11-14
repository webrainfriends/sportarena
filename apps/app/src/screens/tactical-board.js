// Tactical Board — issue #581. Interactive pitch canvas: player tokens, arrows, zones, text.
// Phone: single-panel (Board / Links / Notes). Tablet/desktop: split-pane board + linked video.
import React, { useState, useCallback, useRef } from 'react';
import {
  View, ScrollView, TouchableOpacity, TextInput, StyleSheet, Platform,
  Dimensions, PanResponder, ActivityIndicator,
} from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { c } from '../theme';
import { t } from '../i18n';
import { Btn, Card, T } from '../ui';

const PITCH_TEMPLATES = ['full_pitch','half_pitch','penalty_area','basketball_full','basketball_half','tennis_full','rugby_full','blank'];
const ITEM_KINDS = ['player','marker','arrow','zone','text','line'];
const TEAM_COLORS = { home: '#1D6FA4', away: '#E63946', neutral: '#6B7280' };

const PITCH_LINES = {
  full_pitch: [
    // outline
    { type: 'rect', x: 5, y: 5, w: 90, h: 90 },
    // centre circle
    { type: 'circle', cx: 50, cy: 50, r: 10 },
    // halfway
    { type: 'line', x1: 5, y1: 50, x2: 95, y2: 50 },
    // penalty areas
    { type: 'rect', x: 5, y: 25, w: 15, h: 50 },
    { type: 'rect', x: 80, y: 25, w: 15, h: 50 },
    // goal areas
    { type: 'rect', x: 5, y: 37, w: 6, h: 26 },
    { type: 'rect', x: 89, y: 37, w: 6, h: 26 },
  ],
  half_pitch: [
    { type: 'rect', x: 5, y: 5, w: 90, h: 90 },
    { type: 'rect', x: 5, y: 5, w: 15, h: 90 },
    { type: 'rect', x: 5, y: 25, w: 6, h: 50 },
  ],
  basketball_full: [
    { type: 'rect', x: 5, y: 5, w: 90, h: 90 },
    { type: 'line', x1: 50, y1: 5, x2: 50, y2: 95 },
    { type: 'circle', cx: 50, cy: 50, r: 6 },
    { type: 'circle', cx: 15, cy: 50, r: 20 },
    { type: 'circle', cx: 85, cy: 50, r: 20 },
  ],
  blank: [],
};

// ── SVG-like pitch renderer (pure RN, no extra libs) ─────────────────────────
function PitchBackground({ template, size }) {
  const lines = PITCH_LINES[template] || PITCH_LINES.full_pitch;
  const scale = size / 100;
  const sc = (v) => v * scale;
  return (
    <View style={{ position: 'absolute', left: 0, top: 0, width: size, height: size }}>
      {lines.map((l, i) => {
        if (l.type === 'rect') {
          return (
            <View key={i} style={{
              position: 'absolute', left: sc(l.x), top: sc(l.y),
              width: sc(l.w), height: sc(l.h),
              borderWidth: 1.5, borderColor: 'rgba(255,255,255,.45)',
            }} />
          );
        }
        if (l.type === 'line') {
          const len = Math.sqrt(Math.pow(sc(l.x2 - l.x1), 2) + Math.pow(sc(l.y2 - l.y1), 2));
          const angle = Math.atan2(sc(l.y2 - l.y1), sc(l.x2 - l.x1)) * 180 / Math.PI;
          return (
            <View key={i} style={{
              position: 'absolute', left: sc(l.x1), top: sc(l.y1) - 0.75,
              width: len, height: 1.5, backgroundColor: 'rgba(255,255,255,.45)',
              transformOrigin: 'left center',
              transform: [{ rotate: `${angle}deg` }],
            }} />
          );
        }
        if (l.type === 'circle') {
          const r = sc(l.r);
          return (
            <View key={i} style={{
              position: 'absolute', left: sc(l.cx) - r, top: sc(l.cy) - r,
              width: r * 2, height: r * 2, borderRadius: r,
              borderWidth: 1.5, borderColor: 'rgba(255,255,255,.45)',
            }} />
          );
        }
        return null;
      })}
    </View>
  );
}

function BoardItem({ item, selected, onPress, canvasSize }) {
  const scale = canvasSize / 100;
  const sc = (v) => v * scale;
  const pos = Array.isArray(item.position) ? item.position[0] : item.position;
  const style = item.style || {};

  if (item.kind === 'player') {
    const color = TEAM_COLORS[style.team_side] || TEAM_COLORS.neutral;
    return (
      <TouchableOpacity
        onPress={() => onPress(item)}
        accessibilityRole="button"
        accessibilityLabel={`Player ${style.jersey_no || ''} ${style.team_side || ''}`}
        style={[styles.playerToken, {
          left: sc(pos.x) - 16, top: sc(pos.y) - 16,
          backgroundColor: color,
          borderColor: selected ? '#FFD60A' : 'rgba(255,255,255,.8)',
          borderWidth: selected ? 3 : 2,
        }]}
      >
        <T size={11} style={{ color: '#fff', fontWeight: '800' }}>{style.jersey_no || '•'}</T>
      </TouchableOpacity>
    );
  }
  if (item.kind === 'marker') {
    return (
      <TouchableOpacity
        onPress={() => onPress(item)}
        accessibilityRole="button"
        style={[styles.markerToken, {
          left: sc(pos.x) - 10, top: sc(pos.y) - 10,
          backgroundColor: style.color || c.pink,
          borderColor: selected ? '#FFD60A' : 'transparent',
        }]}
      >
        {item.label ? <T size={9} style={{ color: '#fff', fontWeight: '700' }}>{item.label}</T> : null}
      </TouchableOpacity>
    );
  }
  if (item.kind === 'text') {
    return (
      <View style={{ position: 'absolute', left: sc(pos.x), top: sc(pos.y) }}>
        <T size={12} style={{ color: style.color || '#FFD60A', fontWeight: '700', textShadowColor: '#000', textShadowRadius: 2 }}>{item.label}</T>
      </View>
    );
  }
  return null;
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export function TacticalBoardScreen({ route }) {
  const { boardId: initialBoardId } = route?.params || {};
  const [boardId, setBoardId] = useState(initialBoardId || null);
  const [tab, setTab] = useState('board');
  const [selectedItem, setSelectedItem] = useState(null);
  const [addingKind, setAddingKind] = useState(null);
  const [showNew, setShowNew] = useState(!initialBoardId);
  const [newTitle, setNewTitle] = useState('');
  const [newTemplate, setNewTemplate] = useState('full_pitch');
  const [creating, setCreating] = useState(false);

  const board = useLoad(() => boardId ? api.get(`/tactical-boards/${boardId}`) : null, [boardId]);
  const videoLinks = useLoad(() => boardId ? api.get(`/tactical-boards/${boardId}/video-links`) : null, [boardId]);

  const { width } = Dimensions.get('window');
  const isWide = width >= 768;
  const canvasSize = isWide ? Math.min(width * 0.55, 560) : width - 32;

  const { push, pop } = useNav();

  const createBoard = useCallback(async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const b = await api.post('/tactical-boards', { title: newTitle, pitch_template: newTemplate });
      setBoardId(b.id);
      setShowNew(false);
    } finally { setCreating(false); }
  }, [newTitle, newTemplate]);

  const handleCanvasPress = useCallback(async (evt) => {
    if (!addingKind || !boardId) return;
    const { locationX, locationY } = evt.nativeEvent;
    const pct = { x: (locationX / canvasSize) * 100, y: (locationY / canvasSize) * 100 };
    await api.post(`/tactical-boards/${boardId}/items`, {
      kind: addingKind,
      position: pct,
      style: addingKind === 'player' ? { team_side: 'home', jersey_no: '' } : {},
    });
    board.reload();
    setAddingKind(null);
  }, [addingKind, boardId, canvasSize, board]);

  const handleRemoveItem = useCallback(async (item) => {
    await api.delete(`/tactical-board-items/${item.id}`);
    board.reload();
    setSelectedItem(null);
  }, [board]);

  if (showNew) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg, padding: 24 }]}>
        <T weight="700" size={18} style={{ marginBottom: 20 }}>{t('va.board_new')}</T>
        <T size={12} color={c.mute} style={{ marginBottom: 4 }}>Title</T>
        <TextInput
          style={[styles.input, { backgroundColor: c.paper, color: c.ink, borderColor: c.line }]}
          value={newTitle} onChangeText={setNewTitle}
          placeholder="e.g. Pressing Shape vs 4-4-2"
          placeholderTextColor={c.mute}
          accessibilityLabel="Board title"
        />
        <T size={12} color={c.mute} style={{ marginBottom: 4, marginTop: 12 }}>Pitch template</T>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {PITCH_TEMPLATES.map((pt) => (
              <TouchableOpacity
                key={pt}
                onPress={() => setNewTemplate(pt)}
                style={[styles.catBtn, newTemplate === pt && { backgroundColor: c.pink, borderColor: c.pink }]}
                accessibilityRole="button"
              >
                <T size={12} style={{ color: newTemplate === pt ? '#fff' : c.mute, fontWeight: '700' }}>{pt.replace(/_/g, ' ')}</T>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
        <Btn title={t('va.board_new')} onPress={createBoard} loading={creating} />
      </View>
    );
  }

  const items = board.data?.items || [];

  const boardCanvas = (
    <View style={{ width: canvasSize, height: canvasSize, backgroundColor: '#1a5c27', borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
      <PitchBackground template={board.data?.pitch_template || 'full_pitch'} size={canvasSize} />
      <TouchableOpacity
        style={{ position: 'absolute', left: 0, top: 0, width: canvasSize, height: canvasSize }}
        onPress={handleCanvasPress}
        activeOpacity={1}
        accessibilityRole="button"
        accessibilityLabel="Tactical board canvas"
      >
        {items.map((item) => (
          <BoardItem
            key={item.id}
            item={item}
            selected={selectedItem?.id === item.id}
            onPress={setSelectedItem}
            canvasSize={canvasSize}
          />
        ))}
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <ScrollView contentContainerStyle={[styles.boardOuter, isWide && styles.boardOuterWide]}>
        {/* Board canvas + tools */}
        <View style={isWide ? { flex: 1 } : {}}>
          {board.loading ? <ActivityIndicator color={c.pink} style={{ margin: 32 }} /> : boardCanvas}
          {/* Tool palette */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {ITEM_KINDS.map((k) => (
              <TouchableOpacity
                key={k}
                onPress={() => setAddingKind(addingKind === k ? null : k)}
                style={[styles.catBtn, addingKind === k && { backgroundColor: c.pink, borderColor: c.pink }]}
                accessibilityRole="button"
              >
                <T size={12} style={{ color: addingKind === k ? '#fff' : c.mute, fontWeight: '700' }}>
                  {k === 'player' ? '👤' : k === 'arrow' ? '→' : k === 'zone' ? '⬡' : k === 'marker' ? '📍' : k === 'text' ? 'T' : '—'} {k}
                </T>
              </TouchableOpacity>
            ))}
            {selectedItem && (
              <TouchableOpacity
                onPress={() => handleRemoveItem(selectedItem)}
                style={[styles.catBtn, { borderColor: '#E63946' }]}
                accessibilityRole="button"
              >
                <T size={12} style={{ color: '#E63946', fontWeight: '700' }}>Remove selected</T>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Side panel (tablet) or tab-panel (phone) */}
        {isWide ? (
          <View style={{ width: 280, marginStart: 16 }}>
            <T weight="700" size={14} style={{ marginBottom: 8 }}>{t('va.board_items')} ({items.length})</T>
            <ScrollView style={{ maxHeight: canvasSize - 40 }}>
              {items.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  onPress={() => setSelectedItem(item)}
                  style={[styles.annRow, { borderBottomColor: c.line, flexDirection: 'row', alignItems: 'center' }]}
                  accessibilityRole="button"
                >
                  <T size={12} style={{ flex: 1 }}>{item.kind} {item.label || ''}</T>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <T weight="700" size={14} style={{ marginTop: 16, marginBottom: 8 }}>{t('va.board_link_video')}</T>
            {(videoLinks.data || []).map((l) => (
              <TouchableOpacity
                key={l.id}
                onPress={() => push('VideoAnalysis', { videoId: l.video_id, videoTitle: l.video_title })}
                style={{ paddingVertical: 6 }}
                accessibilityRole="button"
              >
                <T size={12} style={{ color: c.pink }}>{l.video_title} @ {Math.floor(l.timestamp_ms / 1000)}s</T>
              </TouchableOpacity>
            ))}
          </View>
        ) : (
          <View style={{ marginTop: 12 }}>
            <View style={[styles.tabBar, { backgroundColor: c.paper, borderBottomColor: c.line }]}>
              {['items', 'links'].map((tk) => (
                <TouchableOpacity key={tk} onPress={() => setTab(tk)} style={[styles.tabBtn, tab === tk && styles.tabBtnActive]} accessibilityRole="tab">
                  <T size={12} weight={tab === tk ? '700' : '500'} style={{ color: tab === tk ? c.pink : c.mute }}>
                    {tk === 'items' ? t('va.board_items') : t('va.board_link_video')}
                  </T>
                </TouchableOpacity>
              ))}
            </View>
            {tab === 'items' && items.map((item) => (
              <TouchableOpacity key={item.id} onPress={() => setSelectedItem(item)} style={[styles.annRow, { borderBottomColor: c.line }]} accessibilityRole="button">
                <T size={12}>{item.kind} {item.label || ''}</T>
              </TouchableOpacity>
            ))}
            {tab === 'links' && (videoLinks.data || []).map((l) => (
              <TouchableOpacity key={l.id} onPress={() => push('VideoAnalysis', { videoId: l.video_id, videoTitle: l.video_title })} style={{ padding: 12 }} accessibilityRole="button">
                <T size={12} style={{ color: c.pink }}>{l.video_title} @ {Math.floor(l.timestamp_ms / 1000)}s</T>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  boardOuter: { padding: 16 },
  boardOuterWide: { flexDirection: 'row', alignItems: 'flex-start' },
  playerToken: {
    position: 'absolute', width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  markerToken: {
    position: 'absolute', width: 20, height: 20, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center', borderWidth: 2,
  },
  catBtn: {
    borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4,
    borderWidth: 1, borderColor: c.line,
  },
  tabBar: {
    flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabBtn: { paddingHorizontal: 14, paddingVertical: 10 },
  tabBtnActive: { borderBottomWidth: 2, borderBottomColor: '#8458B3' },
  annRow: { flexDirection: 'row', gap: 10, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  input: {
    borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 14,
  },
});
