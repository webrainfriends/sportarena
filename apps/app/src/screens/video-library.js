import React, { useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, H2, Loading, Screen, Tag, T } from '../ui';
import { MenuField } from '../menu-field';
import { HScroll } from '../pickers';
import { FormSheet } from '../FormSheet';
import { saveExport } from '../open-file';
import { c, day } from '../theme';
import { t } from '../i18n';
import { pickMedia } from '../market/media';
import { VideoPlayer } from '../video-player';

// Player video library and highlight showcase (#317): the player's own clips, playlists/highlight reels, match references and who can see what.
// Everything is private until the player chooses; the server re-checks consent, ownership and revocation on every read.
const nice = (s) => String(s).replace(/_/g, ' ');
const VIS = ['private', 'shared', 'public'];
const VIS_COLOR = { private: c.violetSoft, shared: c.cyan, public: c.mint };
const key = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const matchOptions = async (q) => {
  const rows = await api.get('/me/matches', { limit: 40 });
  const needle = q.toLowerCase();
  return rows.filter((m) => !needle || `${m.title} ${m.opponent ?? ''}`.toLowerCase().includes(needle)).map((m) => ({ value: m.activity_id, label: m.title || m.opponent || t('vl.field_match'), sub: [m.played_on && day(m.played_on), m.opponent && `vs ${m.opponent}`].filter(Boolean).join(' · ') }));
};

function ClipCard({ v, onEdit, onVisibility, onPlaylists, onArchive }) {
  return (
    <Card pad={14} style={{ marginTop: 10 }}>
      <VideoPlayer video={v} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 10 }}>
        <T weight="800" style={{ flexShrink: 1 }}>{v.title}</T>
        <Tag label={t(`vl.vis_${v.visibility}`)} color={VIS_COLOR[v.visibility]} />
        {v.archived_at ? <Tag label={t('vl.archived')} color={c.sunSoft} /> : null}
      </View>
      <T size={12} color={c.mute} style={{ marginTop: 2 }}>{[t(`vl.source_${v.source}`), v.sport && v.sport, v.status === 'approved' && t('vl.coach_approved')].filter(Boolean).join(' · ')}</T>
      {v.match ? <T size={12} style={{ marginTop: 4 }}>{t('vl.match_prefix', { title: [v.match.title, v.match.played_on && day(v.match.played_on)].filter(Boolean).join(' · ') })}</T> : null}
      {v.description ? <T size={13} style={{ marginTop: 6 }}>{v.description}</T> : null}
      {v.playlists?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>{v.playlists.map((p) => <Tag key={p.id} label={p.title} color={c.violetSoft} />)}</View> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        {v.archived_at ? <Btn small title={t('vl.restore')} onPress={() => onArchive(v, true)} /> : <>
          <Btn small title={t('vl.visibility')} onPress={() => onVisibility(v)} />
          <Btn small title={t('vl.edit')} color={c.paper} ink={c.ink} onPress={() => onEdit(v)} />
          <Btn small title={t('vl.playlists_short')} color={c.paper} ink={c.ink} onPress={() => onPlaylists(v)} />
          <Btn small title={t('vl.archive')} color={c.paper} ink={c.red} onPress={() => onArchive(v, false)} />
        </>}
      </View>
    </Card>
  );
}

export function VideoLibrary() {
  const { toast } = useSession();
  const [vis, setVis] = useState('all');
  const [sport, setSport] = useState('');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState(null);
  const videos = useLoad(() => api.get('/me/videos', { limit: 100, ...(vis !== 'all' ? { visibility: vis } : {}), ...(sport ? { sport_slug: sport } : {}), include_archived: true }), [vis, sport]);
  const everything = useLoad(() => api.get('/me/videos', { limit: 100 }), []);
  const lists = useLoad(() => api.get('/me/playlists', { limit: 100 }), []);
  const coach = useLoad(() => api.get('/me/coaching-videos'), []);
  const reload = () => Promise.all([videos.reload(), everything.reload(), lists.reload(), coach.reload()]);
  const run = async (fn, msg) => { try { await fn(); if (msg) toast(msg); await reload(); } catch (e) { toast(e.message); } };
  const sports = [...new Map((everything.data ?? []).filter((v) => v.sport_slug).map((v) => [v.sport_slug, v.sport || nice(v.sport_slug)])).entries()].map(([value, label]) => ({ value, label }));

  const upload = async () => {
    const f = await pickMedia();
    if (!f) return;
    setBusy(true);
    try { await api.upload('/me/passport-videos/upload', f.blob, { title: (f.name || 'Clip').replace(/\.[^.]+$/, '').slice(0, 120), visibility: 'private', client_key: key() }); toast(t('vl.uploaded')); await reload(); } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const copy = async (text) => {
    try {
      if (Platform.OS === 'web' && navigator.clipboard) { await navigator.clipboard.writeText(text); toast(t('vl.copied')); } else await Share.share({ message: text });
    } catch (e) { toast(e.message); }
  };
  const exportAll = async () => {
    try { const out = await api.get('/me/video-library/export'); await saveExport({ filename: 'video-library.json', content_type: 'application/json', encoding: 'utf8', content: JSON.stringify(out, null, 2) }); toast(t('vl.exported')); } catch (e) { toast(e.message); }
  };
  const playlistChange = async (v, picked) => {
    const have = new Set((v.playlists ?? []).map((p) => p.id));
    const want = new Set(picked);
    for (const p of lists.data ?? []) {
      if (have.has(p.id) === want.has(p.id)) continue;
      const cur = await api.get(`/me/playlists/${p.id}`);
      const ids = cur.videos.map((x) => x.id);
      await api.post(`/me/playlists/${p.id}/videos`, { version: cur.version, video_ids: want.has(p.id) ? [...ids, v.id] : ids.filter((x) => x !== v.id) });
    }
  };

  return (
    <Screen onRefresh={reload}>
      <T size={13} color={c.mute} style={{ marginTop: 4 }}>{t('vl.intro')}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <Btn title={busy ? t('vl.uploading') : t('vl.upload')} onPress={upload} disabled={busy} />
        <Btn title={t('vl.add_link')} color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'link' })} />
        <Btn title={t('vl.export')} color={c.paper} ink={c.ink} onPress={exportAll} />
      </View>

      <View style={{ marginTop: 14 }}>
        <HScroll>{['all', ...VIS].map((x) => <Chip key={x} label={t(`vl.vis_${x}`)} active={vis === x} onPress={() => setVis(x)} />)}</HScroll>
      </View>
      {sports.length > 1 ? <View style={{ marginTop: 10 }}><MenuField label={t('vl.field_sport')} value={sport} onChange={setSport} options={[{ value: '', label: t('vl.filter_all') }, ...sports]} /></View> : null}

      {videos.error ? <ErrorBox error={videos.error} onRetry={videos.reload} /> : !videos.data ? <Loading /> : !videos.data.length
        ? <Empty emoji="🎬" title={t('vl.empty_title')} sub={t('vl.empty_sub')} />
        : videos.data.map((v) => (
          <ClipCard key={v.id} v={v} onEdit={(x) => setForm({ kind: 'edit', v: x })} onVisibility={(x) => setForm({ kind: 'vis', v: x })} onPlaylists={(x) => setForm({ kind: 'pls', v: x })}
            onArchive={(x, restore) => run(() => api.post(`/me/videos/${x.id}/archive`, { restore }), restore ? t('vl.restored') : t('vl.archived_msg'))} />
        ))}

      <H2 style={{ marginTop: 26 }}>{t('vl.coach_title')}</H2>
      <T size={12} color={c.mute} style={{ marginTop: 2 }}>{t('vl.coach_sub')}</T>
      {coach.data?.length ? coach.data.map((e) => (
        <Card key={e.id} pad={12} color={c.paper} style={{ marginTop: 8 }}>
          <T weight="700">{e.title}</T>
          <T size={12} color={c.mute}>{[t('vl.coach_from', { coach: e.coach_name }), e.observed_on && day(e.observed_on)].filter(Boolean).join(' · ')}</T>
          <Btn small title={t('vl.coach_copy')} onPress={() => run(() => api.post('/me/videos/from-coaching', { evidence_id: e.id }), t('vl.uploaded'))} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
        </Card>
      )) : null}

      <H2 style={{ marginTop: 26 }}>{t('vl.playlists')}</H2>
      <T size={12} color={c.mute} style={{ marginTop: 2 }}>{t('vl.playlists_sub')}</T>
      <Btn small title={t('vl.pl_new')} onPress={() => setForm({ kind: 'plnew' })} style={{ alignSelf: 'flex-start', marginTop: 10 }} />
      {lists.error ? <ErrorBox error={lists.error} onRetry={lists.reload} /> : !lists.data ? <Loading /> : !lists.data.length ? <Empty emoji="🏆" title={t('vl.pl_empty_title')} sub={t('vl.pl_empty_sub')} />
        : lists.data.map((p) => (
          <Card key={p.id} pad={12} color={c.paper} style={{ marginTop: 8 }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <View style={{ flex: 1 }}><T weight="700">{p.title}</T><T size={12} color={c.mute}>{[t(p.kind === 'highlight' ? 'vl.pl_highlight' : 'vl.pl_playlist'), t('vl.pl_count', { n: p.video_count })].join(' · ')}</T></View>
            </View>
            {p.description ? <T size={13} style={{ marginTop: 4 }}>{p.description}</T> : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              <Btn small title={t('vl.pl_manage')} onPress={async () => setForm({ kind: 'plmanage', p: await api.get(`/me/playlists/${p.id}`) })} />
              <Btn small title={t('vl.pl_share')} color={c.paper} ink={c.ink} onPress={() => setForm({ kind: 'plshare', p })} />
              <Btn small title={t('vl.pl_archive')} color={c.paper} ink={c.red} onPress={() => run(() => api.del(`/me/playlists/${p.id}`), t('vl.archived_msg'))} />
            </View>
          </Card>
        ))}

      {link ? (
        <Card pad={14} style={{ marginTop: 14 }}>
          <T weight="700">{t('vl.pl_link_ready')}</T>
          <T size={12} color={c.mute} selectable style={{ marginTop: 6 }}>{link}</T>
          <Btn small title={t('vl.copy')} onPress={() => copy(link)} style={{ alignSelf: 'flex-start', marginTop: 8 }} />
        </Card>
      ) : null}

      {form?.kind === 'link' ? <FormSheet visible onClose={() => setForm(null)} title={t('vl.add_link')} submitLabel={t('vl.add_link')} fields={[
        { key: 'title', label: t('vl.field_title') },
        { key: 'link_url', label: t('vl.field_link'), type: 'url', hint: t('vl.field_link_hint') },
        { key: 'sport_slug', label: t('vl.field_sport'), type: 'sport', optional: true },
        { key: 'match', label: t('vl.field_match'), type: 'multimenu', max: 1, load: matchOptions, optional: true, hint: t('vl.field_match_hint') }]}
        onSubmit={async (v) => { await api.post('/me/passport-videos', { title: v.title, link_url: v.link_url, sport_slug: v.sport_slug || undefined, match_activity_id: v.match?.[0], visibility: 'private', client_key: key() }); await reload(); return t('vl.uploaded'); }} /> : null}

      {form?.kind === 'edit' ? <FormSheet visible onClose={() => setForm(null)} title={t('vl.edit')} submitLabel={t('common.save')}
        initial={{ title: form.v.title, description: form.v.description ?? '', sport_slug: form.v.sport_slug ?? undefined, match: form.v.match_activity_id ? [form.v.match_activity_id] : [] }} fields={[
          { key: 'title', label: t('vl.field_title') },
          { key: 'description', label: t('vl.field_desc'), type: 'multiline', optional: true },
          { key: 'sport_slug', label: t('vl.field_sport'), type: 'sport', optional: true },
          { key: 'match', label: t('vl.field_match'), type: 'multimenu', max: 1, load: matchOptions, optional: true, hint: t('vl.field_match_hint') }]}
        onSubmit={async (v) => { await api.patch(`/me/videos/${form.v.id}`, { version: form.v.version, title: v.title, description: v.description || null, sport_slug: v.sport_slug || null, match_activity_id: v.match?.[0] ?? null }); await reload(); return t('vl.saved'); }} /> : null}

      {form?.kind === 'vis' ? <FormSheet visible onClose={() => setForm(null)} title={t('vl.visibility')} submitLabel={t('common.save')} initial={{ visibility: form.v.visibility }}
        notice={t('vl.consent_note')} fields={[{ key: 'visibility', label: t('vl.visibility'), type: 'chips', options: VIS.map((x) => ({ value: x, label: `${t(`vl.vis_${x}`)} · ${t(`vl.vis_${x}_help`)}` })) }]}
        onSubmit={async (v) => { await api.post(`/me/videos/${form.v.id}/visibility`, { version: form.v.version, visibility: v.visibility }); await reload(); return t('vl.saved'); }} /> : null}

      {form?.kind === 'pls' ? <FormSheet visible onClose={() => setForm(null)} title={t('vl.playlists_short')} submitLabel={t('common.save')} initial={{ pls: (form.v.playlists ?? []).map((p) => p.id) }}
        fields={[{ key: 'pls', label: t('vl.playlists'), type: 'multimenu', options: (lists.data ?? []).map((p) => ({ value: p.id, label: p.title })), optional: true }]}
        onSubmit={async (v) => { await playlistChange(form.v, v.pls ?? []); await reload(); return t('vl.saved'); }} /> : null}

      {form?.kind === 'plnew' ? <FormSheet visible onClose={() => setForm(null)} title={t('vl.pl_new')} submitLabel={t('vl.pl_new')} initial={{ kind: 'highlight' }} fields={[
        { key: 'title', label: t('vl.pl_name') },
        { key: 'kind', label: t('vl.pl_kind'), type: 'chips', options: [{ value: 'highlight', label: t('vl.pl_highlight') }, { value: 'playlist', label: t('vl.pl_playlist') }] },
        { key: 'description', label: t('vl.field_desc'), type: 'multiline', optional: true }]}
        onSubmit={async (v) => { await api.post('/me/playlists', { title: v.title, kind: v.kind, description: v.description || undefined }); await reload(); return t('vl.saved'); }} /> : null}

      {form?.kind === 'plmanage' ? <FormSheet visible onClose={() => setForm(null)} title={t('vl.pl_manage')} submitLabel={t('common.save')} initial={{ title: form.p.title, kind: form.p.kind, description: form.p.description ?? '', videos: form.p.videos.map((x) => x.id) }} fields={[
        { key: 'title', label: t('vl.pl_name') },
        { key: 'kind', label: t('vl.pl_kind'), type: 'chips', options: [{ value: 'highlight', label: t('vl.pl_highlight') }, { value: 'playlist', label: t('vl.pl_playlist') }] },
        { key: 'description', label: t('vl.field_desc'), type: 'multiline', optional: true },
        { key: 'videos', label: t('vl.pl_clips'), type: 'multimenu', options: (everything.data ?? []).map((x) => ({ value: x.id, label: x.title, sub: t(`vl.vis_${x.visibility}`) })), optional: true }]}
        onSubmit={async (v) => {
          const meta = await api.patch(`/me/playlists/${form.p.id}`, { version: form.p.version, title: v.title, kind: v.kind, description: v.description || null });
          await api.post(`/me/playlists/${form.p.id}/videos`, { version: meta.version, video_ids: v.videos ?? [] });
          await reload(); return t('vl.saved');
        }} /> : null}

      {form?.kind === 'plshare' ? <FormSheet visible onClose={() => setForm(null)} title={t('vl.pl_share')} submitLabel={t('vl.pl_share')} initial={{ days: 30 }} notice={t('vl.pl_share_help')} fields={[
        { key: 'days', label: t('vl.pl_expires'), type: 'stepper', min: 1, max: 90, step: 1, default: 30 }]}
        onSubmit={async (v) => { const out = await api.post('/me/passport-links', { playlist_id: form.p.id, expires_in_days: v.days, label: form.p.title.slice(0, 60) }); setLink(out.url || out.path); await reload(); return t('vl.pl_link_ready'); }} /> : null}
    </Screen>
  );
}

/** Highlights of one sport on the sport page: the player's own non-archived clips tagged to that sport. */
export function SportHighlights({ sport }) {
  const v = useLoad(() => api.get('/me/videos', { sport_slug: sport, limit: 6 }), [sport]);
  if (!v.data?.length) return null;
  return (
    <View>
      <H2 style={{ marginTop: 24 }}>{t('vl.highlights')}</H2>
      {v.data.map((x) => <Card key={x.id} pad={12} color={c.paper} style={{ marginTop: 8 }}><VideoPlayer video={x} /><T weight="700" style={{ marginTop: 8 }}>{x.title}</T>{x.match ? <T size={12} color={c.mute}>{t('vl.match_prefix', { title: x.match.title })}</T> : null}</Card>)}
    </View>
  );
}
