import React, { useState } from 'react';
import { Image, Platform, Pressable, View } from 'react-native';
import { api, mediaUrl } from '../api';
import { useSession } from '../session';
import { Btn, Chip, Field, Sheet, T } from '../ui';
import { SportPicker } from '../sportpicker';
import { c } from '../theme';
import { KINDS } from './MarketCard';
import { pickMedia } from './media';

const parseWhen = (s) => { const d = new Date(String(s).trim().replace(' ', 'T')); if (isNaN(d)) throw new Error('Use the format 2026-11-02 17:30'); return d.toISOString(); };
const PLACEHOLDER = { wanted: 'Athletes wanted for relay championship', match: 'Friendly: Sunday 7-a-side', schedule: 'League fixtures — week 3', sale: 'Used cricket kit, great condition', campaign: 'Your campaign headline', announcement: 'What is happening?' };

/** Create a card: pick a kind, write it, attach photos / GIFs / videos, publish (or request a paid placement). */
export function Composer({ visible, onClose, onPosted, initialKind = 'wanted', ad }) {
  const { toast } = useSession();
  const [f, setF] = useState({ kind: ad ? 'campaign' : initialKind, visibility: 'public', sponsored: !!ad });
  const [media, setMedia] = useState([]);
  const [busy, setBusy] = useState(false);
  const [up, setUp] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));

  const addMedia = async () => {
    const file = await pickMedia();
    if (!file) return;
    setUp(true); setErr(null);
    try { const m = await api.upload('/market/media', file.blob); setMedia((l) => [...l, m]); } catch (e) { setErr(e.message); } finally { setUp(false); }
  };
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const priceRupees = f.price ? Number(f.price) : undefined;
      const post = await api.post('/market/posts', {
        kind: f.kind, title: f.title, body: f.body || undefined, sport: f.sport || undefined, city: f.city || undefined,
        starts_at: f.when ? parseWhen(f.when) : undefined, price_cents: priceRupees !== undefined ? Math.round(priceRupees * 100) : undefined,
        positions: f.positions ? Number(f.positions) : undefined, link_url: f.link_url || undefined, cta_label: f.cta_label || undefined,
        visibility: f.sponsored ? 'public' : f.visibility, sponsored: !!f.sponsored, media_ids: media.map((m) => m.id),
      });
      toast(post.sponsor_status === 'pending' ? 'Campaign submitted for review ✓' : 'Posted ✓');
      setF({ kind: initialKind, visibility: 'public' }); setMedia([]);
      onPosted?.(post); onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={ad ? 'Run a campaign' : 'Create a post'}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {Object.entries(KINDS).map(([k, v]) => <Chip key={k} label={`${v.emoji} ${v.label}`} active={f.kind === k} onPress={() => set('kind')(k)} />)}
      </View>
      <Field label="Headline" value={f.title} onChangeText={set('title')} placeholder={PLACEHOLDER[f.kind]} />
      <Field label="Details" value={f.body} onChangeText={set('body')} multiline placeholder="What, who, requirements, how to join…" />
      <SportPicker label="Sport" optional value={f.sport} onChange={set('sport')} />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}><Field label="City" value={f.city} onChangeText={set('city')} /></View>
        <View style={{ flex: 1 }}><Field label="When (2026-11-02 17:30)" value={f.when} onChangeText={set('when')} /></View>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {['wanted', 'match'].includes(f.kind) ? <View style={{ flex: 1 }}><Field label="People needed" value={f.positions} onChangeText={set('positions')} keyboardType="numeric" /></View> : null}
        {f.kind === 'sale' ? <View style={{ flex: 1 }}><Field label="Price (₹)" value={f.price} onChangeText={set('price')} keyboardType="numeric" /></View> : null}
      </View>
      {f.kind === 'campaign' ? <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 2 }}><Field label="Link (https://…)" value={f.link_url} onChangeText={set('link_url')} keyboardType="url" /></View>
        <View style={{ flex: 1 }}><Field label="Button text" value={f.cta_label} onChangeText={set('cta_label')} placeholder="Learn more" /></View>
      </View> : null}

      <View style={{ gap: 8 }}>
        <T weight="600" size={12} color={c.mute} style={{ letterSpacing: 0.4 }}>PHOTOS, GIFS &amp; VIDEOS</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {media.map((m) => (
            <View key={m.id} style={{ width: 84, height: 84, borderRadius: 12, overflow: 'hidden', backgroundColor: c.violet, alignItems: 'center', justifyContent: 'center' }}>
              {m.kind === 'photo' ? <Image source={{ uri: mediaUrl(m.url) }} style={{ width: 84, height: 84 }} /> : <T color="#fff" size={26}>▶</T>}
              <Pressable onPress={() => setMedia((l) => l.filter((x) => x.id !== m.id))} style={{ position: 'absolute', top: 2, right: 2, backgroundColor: 'rgba(15,23,42,0.7)', borderRadius: 10, width: 20, height: 20, alignItems: 'center', justifyContent: 'center' }}><T color="#fff" size={11} weight="800">✕</T></Pressable>
            </View>
          ))}
          {media.length < 8 ? <Pressable onPress={addMedia} disabled={up} style={{ width: 84, height: 84, borderRadius: 12, borderWidth: 1.5, borderStyle: 'dashed', borderColor: c.mute, alignItems: 'center', justifyContent: 'center' }}><T size={22} color={c.mute}>{up ? '…' : '＋'}</T></Pressable> : null}
        </View>
      </View>

      {ad ? <T size={12} color={c.mute}>Campaigns are reviewed by the SportArena team before they appear as Sponsored on the home page. You will be notified when it is approved.</T> : (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip label="🌍 Public" active={f.visibility === 'public' && !f.sponsored} onPress={() => setF((p) => ({ ...p, visibility: 'public', sponsored: false }))} />
          <Chip label="🔒 Members only" active={f.visibility === 'members' && !f.sponsored} onPress={() => setF((p) => ({ ...p, visibility: 'members', sponsored: false }))} />
          <Chip label="⭐ Promote (sponsored)" active={!!f.sponsored} onPress={() => setF((p) => ({ ...p, visibility: 'public', sponsored: !p.sponsored }))} />
        </View>
      )}
      {err ? <T color={c.red} weight="600" size={13}>{err}</T> : null}
      <Btn title={f.sponsored ? 'Submit for review' : 'Publish'} onPress={submit} loading={busy} disabled={!f.title || f.title.length < 3} />
    </Sheet>
  );
}
