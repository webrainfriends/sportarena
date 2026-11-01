// Video and live streams inside the app (iOS, iPadOS, Android and web).
//   file / HLS  : our uploads, and a direct .mp4 / .m3u8 link, play inline with the system player (expo-video: controls, full screen, picture-in-picture).
//   page        : a YouTube, Twitch, Vimeo, Facebook... page cannot be played directly. On a phone it opens in the in-app browser sheet (the app stays underneath);
//                 on the web it opens a new tab. Nothing leaves the app for the system browser any more.
// Only https links are played or opened (our own API host is allowed over http for development). The sign-in header is sent to our own API only, never to another host.
// Nothing autoplays with sound: playback always starts with a tap.
import React, { useMemo, useState } from 'react';
import { Linking, Modal, Platform, Pressable, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { API, authHeader } from './api';
import { Btn, T } from './ui';
import { c } from './theme';

const ORIGIN = API.replace(/\/api\/v1$/, '');
const FILE = /\.(mp4|m4v|mov|webm)(\?|#|$)/i;
const HLS = /\.m3u8(\?|#|$)/i;
const isOwn = (u) => typeof u === 'string' && u.startsWith(ORIGIN);
export const isHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);
/** Safari plays HLS itself; other browsers cannot, so a stream there opens as a page instead. */
const webHls = () => Platform.OS !== 'web' || (typeof document !== 'undefined' && !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl'));

/** 'file' | 'hls' (play here), 'page' (open the page), or null (not a link we will open). */
export function sourceKind(url) {
  if (!url || typeof url !== 'string') return null;
  if (!isHttps(url) && !isOwn(url)) return null;
  if (HLS.test(url)) return webHls() ? 'hls' : 'page';
  if (FILE.test(url) || (isOwn(url) && /\/(media|passport-videos)\//.test(url))) return 'file';
  return 'page';
}

/** Open a web page (a YouTube / Twitch / Vimeo page...) in the in-app browser sheet on a phone, a new tab on the web. */
export async function openPage(url) {
  if (!isHttps(url) && !isOwn(url)) return;
  if (Platform.OS === 'web') { window.open(url, '_blank', 'noopener'); return; }
  try { await require('expo-web-browser').openBrowserAsync(url); } catch { Linking.openURL(url).catch(() => {}); }
}

function Inline({ url, headers, kind, title }) {
  const source = useMemo(() => ({ uri: url, headers, ...(kind === 'hls' ? { contentType: 'hls' } : {}) }), [url, kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const player = useVideoPlayer(source, (p) => { p.loop = false; });
  return <VideoView player={player} nativeControls allowsFullscreen allowsPictureInPicture contentFit="contain" accessibilityLabel={title ?? 'Video'} style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: 14, backgroundColor: '#0F172A' }} />;
}

/** The player for one video: inline when it can play here, otherwise a button that opens its page. */
export function VideoPlayer({ url, title, headers }) {
  const kind = sourceKind(url);
  if (!kind) return null;
  if (kind === 'page') return <Btn small title={`▶ ${title ?? 'Watch'}`} color={c.paper} ink={c.ink} onPress={() => openPage(url)} style={{ alignSelf: 'flex-start' }} accessibilityLabel={`${title ?? 'Watch'}: opens in the app`} />;
  return <Inline url={url} kind={kind} title={title} headers={isOwn(url) ? { ...authHeader(), ...(headers ?? {}) } : undefined} />;
}

/** Full-screen player over the current screen. */
export function VideoModal({ url, title, onClose }) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent supportedOrientations={['portrait', 'landscape']}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.94)', justifyContent: 'center', padding: 12 }}>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close video" hitSlop={12} style={{ position: 'absolute', top: 40, right: 16, zIndex: 2, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><T size={26} color="#fff">✕</T></Pressable>
        <VideoPlayer url={url} title={title} />
        {title ? <T color="#fff" weight="700" style={{ marginTop: 12 }}>{title}</T> : null}
      </View>
    </Modal>
  );
}

/** For a tap on a row or card: const [player, watch] = useWatch(); render {player} once, call watch(url, title). Plays inline when it can, opens the page when not. */
export function useWatch() {
  const [now, setNow] = useState(null);
  const watch = (url, title) => { const k = sourceKind(url); if (k === 'file' || k === 'hls') setNow({ url, title }); else if (k) openPage(url); };
  return [now ? <VideoModal url={now.url} title={now.title} onClose={() => setNow(null)} /> : null, watch];
}
