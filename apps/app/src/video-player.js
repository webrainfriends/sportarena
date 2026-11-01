import React, { useEffect, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { API, api, authHeader } from './api';
import { useSession } from './session';
import { Btn, T } from './ui';
import { c } from './theme';
import { t } from './i18n';

// One player for every video in the app (passport, library, showcase). Web: YouTube/Vimeo in an embedded player, uploaded clips from a blob fetched
// with the viewer's own sign-in. iOS, iPadOS and Android: uploaded clips play in-app with expo-video (the request carries the sign-in header);
// YouTube/Vimeo links open in the system player, because their embeds need a web view.
const web = Platform.OS === 'web';
const rel = (u) => String(u).replace(/^\/api\/v1/, '');

function NativeClip({ video }) {
  const [on, setOn] = useState(false);
  const [mod, setMod] = useState(null);
  useEffect(() => { if (on && !mod) import('expo-video').then(setMod).catch(() => setOn(false)); }, [on, mod]);
  if (!on || !mod) return <Btn small title={t('vl.play')} onPress={() => setOn(true)} style={{ alignSelf: 'flex-start' }} />;
  return <NativeView mod={mod} video={video} />;
}
function NativeView({ mod, video }) {
  const player = mod.useVideoPlayer({ uri: `${API}${rel(video.file_url)}`, headers: authHeader() }, (p) => { p.play(); });
  return <mod.VideoView player={player} nativeControls allowsFullscreen allowsPictureInPicture accessibilityLabel={video.title} style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: 14, backgroundColor: '#0F172A' }} />;
}

export function VideoPlayer({ video }) {
  const { toast } = useSession();
  const [src, setSrc] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => { if (src && web) URL.revokeObjectURL(src); }, [src]);
  const frame = { width: '100%', aspectRatio: '16 / 9', border: 0, borderRadius: 14, background: '#0F172A', display: 'block' };
  if (video.embed_url && web) return React.createElement('iframe', { src: video.embed_url, title: video.title, style: frame, allow: 'accelerometer; encrypted-media; picture-in-picture; fullscreen', allowFullScreen: true, loading: 'lazy', referrerPolicy: 'strict-origin-when-cross-origin' });
  if (video.file_url && web) {
    if (src) return React.createElement('video', { src, controls: true, autoPlay: true, playsInline: true, 'aria-label': video.title, style: { ...frame, objectFit: 'contain' } });
    const load = async () => {
      setBusy(true);
      try { setSrc(URL.createObjectURL(await api.download(rel(video.file_url)))); } catch (e) { toast(e.message); } finally { setBusy(false); }
    };
    return <Btn small title={busy ? t('vl.loading') : t('vl.play')} onPress={load} disabled={busy} style={{ alignSelf: 'flex-start' }} />;
  }
  if (video.file_url) return <NativeClip video={video} />;
  return video.link_url ? <Btn small title={t('vl.open_video')} color={c.paper} ink={c.ink} onPress={() => Linking.openURL(video.link_url)} style={{ alignSelf: 'flex-start' }} /> : <View><T size={12} color={c.mute}>{t('vl.no_playback')}</T></View>;
}
