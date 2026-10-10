import React, { useState } from 'react';
import { Image, Linking, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { api, mediaUrl } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, Loading, Row, Seg, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c } from '../theme';
import { locale } from '../locale';

const isWeb = Platform.OS === 'web';
const h = React.createElement;
const Stars = ({ n = 0, size = 16 }) => <T size={size} color="#F59E0B">{'★'.repeat(Math.round(n))}<T size={size} color={c.line}>{'★'.repeat(5 - Math.round(n))}</T></T>;
export { Stars };

/** One tile of media: photo, uploaded video, or YouTube/Vimeo embed. `full` renders it large with controls. */
function MediaView({ m, w, hgt, full, onPress }) {
  const url = mediaUrl(m.url);
  if (m.kind === 'photo') return <Pressable onPress={onPress}><Image source={{ uri: url }} resizeMode={full ? 'contain' : 'cover'} style={{ width: w, height: hgt, borderRadius: full ? 0 : 14, backgroundColor: c.violetSoft }} accessibilityLabel={m.caption ?? 'Venue photo'} /></Pressable>;
  if (isWeb && full) {
    return m.kind === 'video'
      ? h('video', { src: url, controls: true, autoPlay: true, playsInline: true, style: { width: '100%', maxHeight: '80vh', borderRadius: 8, background: '#000' } })
      : h('iframe', { src: m.url, allow: 'accelerometer; autoplay; encrypted-media; picture-in-picture', allowFullScreen: true, style: { width: '100%', aspectRatio: '16/9', border: 0, borderRadius: 8 } });
  }
  return (
    <Pressable onPress={onPress ?? (() => Linking.openURL(m.kind === 'video' ? url : m.url))} style={{ width: w, height: hgt, borderRadius: full ? 0 : 14, backgroundColor: c.violet, alignItems: 'center', justifyContent: 'center' }}>
      <T size={34} color="#fff">▶</T><T size={12} color="#fff" weight="700">{m.caption ?? 'Watch video'}</T>
    </Pressable>
  );
}

/** Horizontal gallery with a full-screen viewer. */
export function Gallery({ media, width = 300 }) {
  const [at, setAt] = useState(null);
  if (!media?.length) return null;
  const cur = at != null ? media[at] : null;
  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingVertical: 4 }}>
        {media.map((m, i) => <MediaView key={m.id} m={m} w={m === media[0] ? width * 1.35 : width} hgt={width * 0.72} onPress={() => setAt(i)} />)}
      </ScrollView>
      <Modal visible={at != null} transparent animationType="fade" onRequestClose={() => setAt(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center', padding: 12 }}>
          <Pressable onPress={() => setAt(null)} style={{ position: 'absolute', top: 24, right: 20, zIndex: 2, padding: 8 }}><T size={26} color="#fff">✕</T></Pressable>
          {cur ? <View style={{ alignItems: 'center' }}><MediaView m={cur} w="100%" hgt={500} full onPress={() => {}} />{cur.caption ? <T color="#fff" style={{ marginTop: 10 }}>{cur.caption}</T> : null}</View> : null}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 16, paddingHorizontal: 12 }}>
            <Btn small title="‹ Prev" color={c.paper} onPress={() => setAt((i) => (i + media.length - 1) % media.length)} />
            <T color="#fff" weight="700">{(at ?? 0) + 1} / {media.length}</T>
            <Btn small title="Next ›" color={c.paper} onPress={() => setAt((i) => (i + 1) % media.length)} />
          </View>
        </View>
      </Modal>
    </>
  );
}

/** Pick a photo/video from the device. Web: a hidden <input type=file>. Native: expo-image-picker. Resolves to { blob } or null. */
async function pickFile() {
  if (isWeb) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm';
      input.onchange = () => resolve(input.files?.[0] ? { blob: input.files[0] } : null);
      input.click();
    });
  }
  const ImagePicker = await import('expo-image-picker');
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.85 });
  if (r.canceled || !r.assets?.[0]) return null;
  return { blob: await (await fetch(r.assets[0].uri)).blob() };
}

/** Venue-team gallery manager: upload, link a video, set cover, caption, reorder, remove. */
export function MediaManager({ venue }) {
  const { toast } = useSession();
  const list = useLoad(() => api.get(`/venues/${venue.id}/media`), [venue.id]);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState(false);
  const [cap, setCap] = useState(null);
  const run = async (fn, msg) => { try { await fn(); if (msg) toast(msg); list.reload(); } catch (e) { toast(e.message); } };
  const add = async () => {
    const f = await pickFile();
    if (!f) return;
    setBusy(true);
    await run(() => api.upload(`/venues/${venue.id}/media`, f.blob), 'Uploaded');
    setBusy(false);
  };
  const move = (i, d) => { const ids = list.data.map((m) => m.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; run(() => api.post(`/venues/${venue.id}/media/order`, { ids })); };
  return (
    <View style={{ gap: 10 }}>
      <T color={c.mute} size={13}>Photos (up to 10 MB) and videos (up to 150 MB; MP4, MOV, WebM) appear on your venue page. The cover is the first photo guests see.</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Btn small title="+ Upload photo / video" color={c.violet} onPress={add} loading={busy} />
        <Btn small title="+ YouTube / Vimeo link" color={c.paper} onPress={() => setLink(true)} />
      </View>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.data.length ? list.data.map((m, i) => (
        <Card key={m.id} pad={10}>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <MediaView m={m} w={110} hgt={80} onPress={() => setCap(m)} />
            <View style={{ flex: 1, gap: 6 }}>
              <View style={{ flexDirection: 'row', gap: 6 }}><Tag label={m.kind.replace('_', ' ')} />{m.is_cover ? <Tag label="cover" color={c.mint} /> : null}</View>
              <T size={13} color={c.mute}>{m.caption ?? 'No caption'}</T>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                <Btn small title="↑" color={c.paper} onPress={() => move(i, -1)} /><Btn small title="↓" color={c.paper} onPress={() => move(i, 1)} />
                {m.kind === 'photo' && !m.is_cover ? <Btn small title="Make cover" color={c.paper} onPress={() => run(() => api.patch(`/media/${m.id}`, { is_cover: true }), 'Cover updated')} /> : null}
                <Btn small title="Caption" color={c.paper} onPress={() => setCap(m)} />
                <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => run(() => api.del(`/media/${m.id}`), 'Removed from the page')} />
              </View>
            </View>
          </View>
        </Card>
      )) : <Empty emoji="📸" title="No photos or videos yet" sub="Add a few — venues with photos get far more bookings." />}
      <FormSheet visible={!!cap} onClose={() => setCap(null)} title="Caption" initial={{ caption: cap?.caption ?? '' }} fields={[{ key: 'caption', label: 'Caption' }]}
        onSubmit={async (f) => { await api.patch(`/media/${cap.id}`, f); list.reload(); return 'Saved'; }} />
      <FormSheet visible={link} onClose={() => setLink(false)} title="Add a video link" fields={[{ key: 'url', label: 'YouTube or Vimeo link' }, { key: 'caption', label: 'Caption', optional: true }]}
        onSubmit={async (f) => { await api.post(`/venues/${venue.id}/media/link`, f); list.reload(); return 'Video added'; }} />
    </View>
  );
}

const SORTS = [['recent', 'Newest'], ['verified', 'Verified players'], ['highest', 'Highest'], ['lowest', 'Lowest']];
/** Ratings summary, star distribution, reviews (verified mark, team replies), write/edit and reply. */
export function VenueReviews({ venueId }) {
  const { user, toast } = useSession();
  const [sort, setSort] = useState('recent');
  const [stars, setStars] = useState(0);
  const [write, setWrite] = useState(false);
  const [reply, setReply] = useState(null);
  const r = useLoad(() => api.get(`/venues/${venueId}/reviews`, { sort, stars: stars || undefined, limit: 30 }), [venueId, sort, stars]);
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const d = r.data;
  const total = Math.max(1, d.count);
  return (
    <View style={{ gap: 12 }}>
      <Card>
        <View style={{ flexDirection: 'row', gap: 18, alignItems: 'center' }}>
          <View style={{ alignItems: 'center' }}><T size={40} weight="800">{d.average ?? '–'}</T><Stars n={d.average ?? 0} size={16} /><T size={12} color={c.mute}>{d.count} rating{d.count === 1 ? '' : 's'}</T></View>
          <View style={{ flex: 1, gap: 4 }}>
            {[5, 4, 3, 2, 1].map((s) => (
              <Pressable key={s} onPress={() => setStars(stars === s ? 0 : s)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T size={12} weight={stars === s ? '700' : '500'} style={{ width: 22 }}>{s}★</T>
                <View style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: c.violetSoft, overflow: 'hidden' }}><View style={{ width: `${(d.distribution[s] / total) * 100}%`, height: 8, backgroundColor: '#F59E0B' }} /></View>
                <T size={12} color={c.mute} style={{ width: 24, textAlign: 'right' }}>{d.distribution[s]}</T>
              </Pressable>
            ))}
          </View>
        </View>
        {user && !d.can_manage ? <Btn small title={d.my_review ? 'Edit your review' : 'Write a review'} onPress={() => setWrite(true)} style={{ marginTop: 12, alignSelf: 'flex-start' }} /> : null}
      </Card>
      <Seg options={SORTS.map(([value, label]) => ({ value, label }))} value={sort} onChange={setSort} color={c.violet} />
      {stars ? <Chip label={`${stars}★ only ✕`} active onPress={() => setStars(0)} /> : null}
      {d.items.length ? d.items.map((x) => (
        <Card key={x.id}>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <Avatar user={{ avatar_color: x.avatar_color, avatar_emoji: x.avatar_emoji, avatar_url: x.avatar_url, handle: x.handle }} size={36} />
            <View style={{ flex: 1 }}><T weight="700">{x.display_name}</T><View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}><Stars n={x.rating} size={13} />{x.verified ? <Tag label="played here" color={c.mint} /> : null}</View></View>
            <T size={11} color={c.mute}>{new Date(x.created_at).toLocaleDateString(locale)}</T>
          </View>
          <T style={{ marginTop: 8 }}>{x.body}</T>
          {x.reply ? <View style={{ marginTop: 10, padding: 10, borderRadius: 10, backgroundColor: c.violetSoft }}><T size={12} weight="700">Reply from {x.reply.by ?? 'the venue'}</T><T size={13}>{x.reply.body}</T></View> : null}
          {d.can_manage ? <Btn small title={x.reply ? 'Edit reply' : 'Reply'} color={c.paper} onPress={() => setReply(x)} style={{ marginTop: 8, alignSelf: 'flex-start' }} /> : null}
        </Card>
      )) : <Empty emoji="💬" title={stars ? 'No reviews with that rating' : 'No reviews yet'} sub={d.can_manage ? 'Reviews from your guests appear here.' : 'Played here? Be the first to share how it was.'} />}
      <FormSheet visible={write} onClose={() => setWrite(false)} title="Your review" submitLabel="Post it" initial={d.my_review ? { rating: d.my_review.rating, body: d.my_review.body } : {}}
        fields={[{ key: 'rating', label: 'Rating', type: 'choice', options: [5, 4, 3, 2, 1].map((n) => ({ value: n, label: '★'.repeat(n) })) }, { key: 'body', label: 'How was it? (courts, staff, value, facilities)', type: 'multiline' }]}
        onSubmit={async (f) => { await api.post('/testimonials', { subject_type: 'venue', subject_id: venueId, ...f }); r.reload(); return 'Thanks for the feedback'; }} />
      <FormSheet visible={!!reply} onClose={() => setReply(null)} title={`Reply to ${reply?.display_name ?? ''}`} submitLabel="Post reply" initial={{ body: reply?.reply?.body ?? '' }}
        fields={[{ key: 'body', label: 'Your reply (public)', type: 'multiline' }]}
        onSubmit={async (f) => { await api.post(`/reviews/${reply.id}/reply`, f); r.reload(); return 'Reply posted'; }} />
    </View>
  );
}
