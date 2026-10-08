import React, { useState } from 'react';
import { Image, Modal, Platform, Pressable, View } from 'react-native';
import { mediaUrl } from '../api';
import { T } from '../ui';
import { c } from '../theme';

const isWeb = Platform.OS === 'web';
const h = React.createElement;

/** Pick a photo / GIF / video. Web: hidden <input type=file>. Native: expo-image-picker. Resolves to { blob, name } or null. */
export async function pickMedia() {
  if (isWeb) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm';
      input.onchange = () => resolve(input.files?.[0] ? { blob: input.files[0], name: input.files[0].name } : null);
      input.click();
    });
  }
  const ImagePicker = await import('expo-image-picker');
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.85 });
  if (r.canceled || !r.assets?.[0]) return null;
  return { blob: await (await fetch(r.assets[0].uri)).blob(), name: r.assets[0].fileName };
}

/** One piece of media. Photos and GIFs are images; videos autoplay muted on the web (tap for a full-screen player). */
export function Media({ m, height, onPress, full }) {
  const url = mediaUrl(m.url);
  if (m.kind === 'video') {
    if (isWeb) return h('video', { src: url, muted: !full, loop: !full, autoPlay: true, playsInline: true, controls: !!full, preload: 'metadata', onClick: onPress, style: { width: '100%', height: full ? undefined : height, maxHeight: full ? '80vh' : undefined, objectFit: full ? 'contain' : 'cover', background: '#0F172A', display: 'block', cursor: onPress ? 'pointer' : undefined } });
    return <Pressable onPress={onPress} style={{ width: '100%', height, backgroundColor: c.violet, alignItems: 'center', justifyContent: 'center' }}><T size={34} color="#fff">▶</T></Pressable>;
  }
  return <Pressable onPress={onPress} disabled={!onPress}><Image source={{ uri: url }} resizeMode={full ? 'contain' : 'cover'} style={{ width: '100%', height: full ? 520 : height, backgroundColor: c.violetSoft }} accessibilityLabel="Post media" /></Pressable>;
}

/** Media block for a card: 1 item full width, 2+ as a mosaic. Tap opens a viewer. */
export function MediaGrid({ media, height = 220 }) {
  const [at, setAt] = useState(null);
  if (!media?.length) return null;
  const shown = media.slice(0, 3);
  const cell = (m, i, hgt) => <View key={m.id} style={{ flex: 1, overflow: 'hidden' }}><Media m={m} height={hgt} onPress={() => setAt(i)} />{i === 2 && media.length > 3 ? <View pointerEvents="none" style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(15,23,42,0.55)', alignItems: 'center', justifyContent: 'center' }}><T color="#fff" weight="800" size={22}>+{media.length - 3}</T></View> : null}</View>;
  return (
    <>
      <View style={{ gap: 2, overflow: 'hidden' }}>
        {shown.length === 1 ? cell(shown[0], 0, height) : (
          <>
            <View style={{ flexDirection: 'row' }}>{cell(shown[0], 0, height)}</View>
            <View style={{ flexDirection: 'row', gap: 2 }}>{shown.slice(1).map((m, j) => cell(m, j + 1, height * 0.5))}</View>
          </>
        )}
      </View>
      <Modal visible={at != null} transparent animationType="fade" onRequestClose={() => setAt(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', padding: 12 }}>
          <Pressable onPress={() => setAt(null)} style={{ position: 'absolute', top: 24, right: 20, zIndex: 2, padding: 8 }}><T size={26} color="#fff">✕</T></Pressable>
          {at != null ? <Media m={media[at]} full /> : null}
          {media.length > 1 ? <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 16, paddingHorizontal: 12 }}>
            <Pressable onPress={() => setAt((i) => (i + media.length - 1) % media.length)}><T color="#fff" weight="700">‹ Prev</T></Pressable>
            <T color="#fff" weight="700">{at + 1} / {media.length}</T>
            <Pressable onPress={() => setAt((i) => (i + 1) % media.length)}><T color="#fff" weight="700">Next ›</T></Pressable>
          </View> : null}
        </View>
      </Modal>
    </>
  );
}
