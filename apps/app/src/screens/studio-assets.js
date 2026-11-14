import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, Loading, T, Tag } from '../ui';
import { c, r } from '../theme';
import { FormSheet } from '../FormSheet';

export function StudioAssets({ onSelect }) {
  const assets = useLoad(() => api.get('/admin/landing/assets'), []);
  const [uploading, setUploading] = useState(false);

  if (assets.loading && !assets.data) return <Loading />;
  if (assets.error) return <ErrorBox error={assets.error} onRetry={assets.reload} />;

  const list = assets.data ? assets.data.assets : [];

  const archive = async (id) => {
    try {
      await api.post('/admin/landing/assets/' + id + '/archive');
      assets.reload();
    } catch (e) { /* silent */ }
  };

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <T weight="800" size={18}>Asset Manager</T>
        <Btn small title="+ Upload" onPress={() => setUploading(true)} />
      </View>

      {list.length === 0
        ? <Empty emoji="🖼️" title="No assets" sub="Upload media for your landing page blocks." />
        : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {list.map((a) => (
              <Pressable key={a.id} onPress={() => onSelect && onSelect(a)} accessibilityRole="button" accessibilityLabel={a.filename}
                style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
                <View style={{ width: 150, backgroundColor: c.paper, borderRadius: r.card, overflow: 'hidden', borderWidth: 1, borderColor: c.line }}>
                  <View style={{ height: 90, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}>
                    <T size={28}>{a.mime_type && a.mime_type.startsWith('video') ? '🎬' : '🖼️'}</T>
                  </View>
                  <View style={{ padding: 10, gap: 4 }}>
                    <T size={12} weight="700" numberOfLines={1}>{a.filename}</T>
                    <Tag label={a.mime_type ? a.mime_type.split('/')[1] : 'file'} color={c.cyanSoft} />
                    <Btn small title="Archive" color={c.paper} ink={c.red} onPress={() => archive(a.id)} />
                  </View>
                </View>
              </Pressable>
            ))}
          </View>
        )}

      <FormSheet visible={uploading} onClose={() => setUploading(false)} title="Register asset"
        submitLabel="Register"
        fields={[
          { key: 'filename', label: 'Filename', placeholder: 'hero-dark.jpg' },
          { key: 'mime_type', label: 'MIME type', placeholder: 'image/jpeg' },
          { key: 'storage_key', label: 'CDN storage key', placeholder: 'landing/assets/abc123.jpg', hint: 'The object key on your CDN bucket' },
          { key: 'alt_text', label: 'Alt text', placeholder: 'Descriptive text for screen readers', optional: true },
        ]}
        onSubmit={async (v) => {
          await api.post('/admin/landing/assets', v);
          assets.reload();
          return 'Asset registered';
        }}
      />
    </View>
  );
}
