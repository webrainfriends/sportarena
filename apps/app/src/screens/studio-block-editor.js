import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { Btn, Card, Field, T, Tag } from '../ui';
import { c, r } from '../theme';

const MOTION_PRESETS = [
  { value: 'rise', label: 'Rise' },
  { value: 'fade', label: 'Fade' },
  { value: 'slide', label: 'Slide' },
  { value: 'none', label: 'None' },
];

const CHAPTER_KEYS = ['news', 'athletes', 'venues', 'academies', 'matches', 'coaches', 'physios', 'sponsors', 'suppliers', 'learn'];

export function StudioBlockEditor({ block, pageId, onSaved }) {
  const cfg = block.config || {};
  const [chapter, setChapter] = useState(cfg.chapter || '');
  const [motionPreset, setMotionPreset] = useState(cfg.motion_preset || 'rise');
  const [ctaRouteKey, setCtaRouteKey] = useState(cfg.cta_route_key || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.patch('/admin/landing/pages/' + pageId + '/blocks/' + block.id, {
        config: { ...cfg, chapter, motion_preset: motionPreset, cta_route_key: ctaRouteKey },
      });
      onSaved && onSaved();
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ gap: 16 }}>
      <T weight="800" size={18}>Edit Block</T>

      <Card>
        <T weight="700" size={13} color={c.mute} style={{ marginBottom: 10 }}>BLOCK TYPE</T>
        <Tag label={block.block_type.replace(/_/g, ' ')} color={c.pinkSoft} />
      </Card>

      {block.block_type === 'chapter_showcase' && (
        <Card>
          <T weight="700" size={13} color={c.mute} style={{ marginBottom: 10 }}>CHAPTER</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {CHAPTER_KEYS.map((k) => {
              const sel = chapter === k;
              return (
                <Btn key={k} small title={k} color={sel ? c.pink : c.paper} ink={sel ? '#fff' : c.mute} onPress={() => setChapter(k)} />
              );
            })}
          </View>
        </Card>
      )}

      <Card>
        <T weight="700" size={13} color={c.mute} style={{ marginBottom: 10 }}>MOTION PRESET</T>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {MOTION_PRESETS.map((mp) => {
            const sel = motionPreset === mp.value;
            return (
              <Btn key={mp.value} small title={mp.label} color={sel ? c.violet : c.paper} ink={sel ? '#fff' : c.mute} onPress={() => setMotionPreset(mp.value)} />
            );
          })}
        </View>
      </Card>

      <Card>
        <Field
          label="CTA route key"
          value={ctaRouteKey}
          onChangeText={setCtaRouteKey}
          placeholder="e.g. athlete-discovery"
          hint="Internal route key the CTA button navigates to"
        />
      </Card>

      {error && <T size={13} color={c.red}>{error}</T>}
      <Btn title="Save block" loading={saving} onPress={save} />
    </View>
  );
}
