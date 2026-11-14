import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, Row, T, Tag } from '../ui';
import { c, r } from '../theme';
import { FormSheet } from '../FormSheet';

const BLOCK_TYPES = [
  { value: 'cinematic_hero', label: 'Cinematic hero' },
  { value: 'chapter_showcase', label: 'Chapter showcase' },
  { value: 'news_pulse', label: 'News pulse' },
  { value: 'role_selector', label: 'Role selector' },
  { value: 'cta_strip', label: 'CTA strip' },
  { value: 'stat_row', label: 'Stat row' },
  { value: 'trust_strip', label: 'Trust strip' },
  { value: 'footer', label: 'Footer' },
];

export function StudioBlocks({ pageId, onSelect }) {
  const blocks = useLoad(() => api.get('/admin/landing/pages/' + pageId + '/blocks'), [pageId]);
  const [adding, setAdding] = useState(false);

  if (blocks.loading && !blocks.data) return <Loading />;
  if (blocks.error) return <ErrorBox error={blocks.error} onRetry={blocks.reload} />;

  const list = blocks.data ? blocks.data.blocks : [];

  const toggleVisible = async (block) => {
    try {
      await api.patch('/admin/landing/pages/' + pageId + '/blocks/' + block.id, { visible: !block.visible });
      blocks.reload();
    } catch (e) { /* silent */ }
  };

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <T weight="800" size={18}>Block Library</T>
        <Btn small title="+ Add block" onPress={() => setAdding(true)} />
      </View>

      {list.length === 0
        ? <Empty emoji="🧱" title="No blocks" sub="Add blocks to build your page." />
        : list.map((b) => (
          <Card key={b.id} onPress={() => onSelect(b)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ width: 32, height: 32, backgroundColor: c.violetSoft, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }}>
                <T size={13} weight="700" color={c.mute}>{'⠿'}</T>
              </View>
              <View style={{ flex: 1 }}>
                <T weight="700" size={14}>{BLOCK_TYPES.find((bt) => bt.value === b.block_type) ? BLOCK_TYPES.find((bt) => bt.value === b.block_type).label : b.block_type}</T>
                <T size={12} color={c.mute}>{'Position ' + b.position}</T>
              </View>
              <Pressable onPress={() => toggleVisible(b)} accessibilityRole="switch" accessibilityLabel={b.visible ? 'Hide block' : 'Show block'} accessibilityState={{ checked: b.visible }}>
                <View style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: r.pill, backgroundColor: b.visible ? c.pinkSoft : c.line }}>
                  <T size={11} weight="700" color={b.visible ? c.pink : c.mute}>{b.visible ? 'Visible' : 'Hidden'}</T>
                </View>
              </Pressable>
            </View>
          </Card>
        ))}

      <FormSheet visible={adding} onClose={() => setAdding(false)} title="Add block"
        submitLabel="Add"
        fields={[
          { key: 'block_type', label: 'Block type', type: 'chips', options: BLOCK_TYPES },
          { key: 'position', label: 'Position', type: 'stepper', min: 0, max: 100, hint: 'Lower = higher on page' },
        ]}
        initial={{ block_type: 'chapter_showcase', position: list.length }}
        onSubmit={async (v) => {
          await api.post('/admin/landing/pages/' + pageId + '/blocks', v);
          blocks.reload();
          return 'Block added';
        }}
      />
    </View>
  );
}
