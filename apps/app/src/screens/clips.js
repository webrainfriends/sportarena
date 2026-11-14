// AI highlights & smart clips (#505): the Highlights tab of the event console. Line a recording up with a game, find the moments the scoring record justifies,
// review and edit the clips, publish only what the rights allow, and assemble recap reels. The server decides every rule (rights, consent, review); this screen
// shows the live state and the reason when something is held back. Built from the shared arena components, so it adapts from phone to desktop.
import React, { useMemo, useState } from 'react';
import { Image, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { t } from '../i18n';
import { A, ABtn, ACard, AChip, AEmpty, ARow, ASection, AStepper, AT, ATag, ReasonSheet } from '../arena';
import { ErrorBox, Field, Loading, Sheet } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField, MultiMenuField } from '../menu-field';
import { VideoScrubber } from '../components/VideoScrubber';

export const CLIP_STATUSES = ['candidate', 'processing', 'review', 'approved', 'published', 'withdrawn', 'rejected', 'failed'];
const TONE = { candidate: A.mute, processing: A.sun, review: A.cyan, approved: A.lime, published: A.green, withdrawn: A.orange, rejected: A.red, failed: A.red };
const STATE_KEYS = { live: 'clips.state.live', draft: 'clips.state.draft', taken_down: 'clips.state.taken_down', consent_lapsed: 'clips.state.consent_lapsed' };

/** A translated label with the server's own wording as the fallback for kinds we have no key for. */
export const tr = (key, fallback) => { const v = t(key); return v === key ? fallback ?? key : v; };
export const momentName = (kind, label) => tr(`clips.m.${kind}`, label ?? String(kind).replace(/_/g, ' '));
export const stateName = (state) => (state ? tr(STATE_KEYS[state] ?? 'clips.state.hidden') : '');
const secs = (n) => Math.round(Number(n) * 10) / 10;
const peopleLoader = async (q) => {
  const r = await api.get('/people', { q: q || undefined, limit: 20 });
  return (Array.isArray(r) ? r : r.items ?? []).map((p) => ({ value: p.id, label: p.display_name ?? p.handle }));
};

export function ClipsPanel({ id, games = [] }) {
  const { toast } = useSession();
  const [pick, setSrc] = useState(null);
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(null);
  const [alignForm, setAlignForm] = useState(false);
  const [bmForm, setBmForm] = useState(false);
  const [useAi, setUseAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reel, setReel] = useState(null);       // { reel? } -> new or existing reel sheet
  const assets = useLoad(() => api.get(`/events/${id}/media/assets`, { limit: 100 }), [id]);
  const queue = useLoad(() => api.get(`/events/${id}/clips`, { status: status ?? undefined, limit: 100 }), [id, status]);
  const usage = useLoad(() => api.get(`/events/${id}/clip-usage`).catch(() => null), [id]);
  const sessions = useLoad(() => api.get(`/events/${id}/sessions`, { limit: 100 }).catch(() => ({ items: [] })), [id]);
  const reels = useLoad(() => api.get(`/events/${id}/reels`).catch(() => ({ items: [] })), [id]);
  const recordings = useMemo(() => (assets.data?.items ?? []).filter((a) => a.kind === 'video' && a.link).map((a) => ({ value: a.id, label: a.title })), [assets.data]);
  const src = pick ?? (recordings.length === 1 ? recordings[0].value : null);   // one recording: no need to ask
  const al = useLoad(() => (src ? api.get(`/media/assets/${src}/clip-alignment`) : Promise.resolve(null)), [src]);
  const targets = useMemo(() => [
    ...games.slice(0, 60).map((g) => ({ value: `f:${g.id}`, label: `${g.home?.name ?? g.home_name ?? '–'} v ${g.away?.name ?? g.away_name ?? '–'}` })),
    ...((sessions.data?.items ?? sessions.data ?? []).slice?.(0, 60) ?? []).map((s) => ({ value: `s:${s.id}`, label: s.label ?? s.stage })),
  ], [games, sessions.data]);
  const reload = () => { queue.reload(); usage.reload(); reels.reload(); al.reload(); };

  if (queue.error) return <ErrorBox error={queue.error} onRetry={reload} />;
  if (!queue.data || !assets.data) return <Loading />;
  const q = queue.data;
  const cur = al.data?.current;

  const find = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/media/assets/${src}/clip-candidates`, { use_ai: useAi });
      toast(t('clips.found', { n: r.created.length, m: r.existing.length }));
      if (r.notes?.length) toast(t('clips.totals_note'));
      reload();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  const setPolicy = async (mode) => { try { await api.post(`/events/${id}/clip-policy`, { mode, audience: q.policy.audience ?? 'public' }); toast(t('clips.policy_saved')); queue.reload(); } catch (e) { toast(e.message); } };

  return (
    <>
      <ASection title={t('clips.title')} sub={t('clips.sub')} />
      <ACard>
        <View style={{ gap: 12 }}>
          <MenuField label={t('clips.recording_pick')} value={src} onChange={setSrc} options={recordings} placeholder={recordings.length ? t('clips.recording_pick') : t('clips.no_recordings')} />
          {src ? (
            <>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <ATag label={cur ? t('clips.aligned') : t('clips.not_aligned')} tone={cur ? A.green : A.sun} />
                <ABtn small tone="ghost" title={t('clips.align')} onPress={() => setAlignForm(true)} />
                <ABtn small tone="neon" title={t('clips.find')} onPress={find} loading={busy} disabled={!cur} />
              </View>
              <AChip label={t('clips.use_ai')} active={useAi} onPress={() => setUseAi(!useAi)} />
            </>
          ) : null}
          <ABtn small tone="ghost" title={t('clips.bookmark')} onPress={() => setBmForm(true)} />
        </View>
      </ACard>

      {q.can.manage ? <ACard>
        <View style={{ gap: 8 }}>
          <AT size={13} weight="800">{t('clips.policy')}</AT>
          <AChip label={t('clips.policy_auto')} active={q.policy.mode === 'trusted_auto'} onPress={() => setPolicy(q.policy.mode === 'trusted_auto' ? 'manual' : 'trusted_auto')} />
          {usage.data ? <AT size={12} color={A.mute}>{t('clips.usage', { credits: usage.data.total.credits, secs: secs(usage.data.total.processing_s) })}</AT> : null}
        </View>
      </ACard> : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <AChip label={t('common.all')} active={!status} onPress={() => setStatus(null)} />
        {CLIP_STATUSES.map((s) => <AChip key={s} label={t(`clips.st.${s}`)} active={status === s} onPress={() => setStatus(s)} badge={status ? undefined : q.counts[s]} />)}
      </View>

      {!q.items.length ? <AEmpty emoji="🎞️" title={t('clips.empty')} sub={t('clips.empty_sub')} /> : q.items.map((c) => (
        <ARow key={c.id} onPress={() => setOpen(c.id)} tone={c.status === 'review' ? A.cyan : undefined}
          title={c.title ?? momentName(c.moment_kind, c.label)}
          sub={[momentName(c.moment_kind, c.label), t(`clips.cite.${c.cites.kind}`), t('clips.window', { from: secs(c.media.start_s), to: secs(c.media.end_s) })].join(' · ')}
          right={<><ATag label={t(`clips.st.${c.status}`)} tone={TONE[c.status]} />{c.rights && c.rights.state && c.rights.state !== 'live' && c.status === 'published' ? <ATag label={stateName(c.rights.state)} tone={A.red} /> : null}</>} />
      ))}

      {q.can.manage ? <ASection title={t('clips.reels')} action={`+ ${t('clips.reel_new')}`} onAction={() => setReel({})} /> : null}
      {(reels.data?.items ?? []).map((r) => (
        <ARow key={r.id} title={r.title} sub={`${r.items.filter((x) => x.kind === 'clip').length} · ${t(`clips.st.${r.status === 'draft' ? 'candidate' : r.status}`)}`} onPress={() => setReel({ reel: r })} />
      ))}

      <FormSheet visible={alignForm} onClose={() => setAlignForm(false)} title={t('clips.align')} sub={t('clips.align_help')}
        initial={cur ? { target: cur.fixture_id ? `f:${cur.fixture_id}` : `s:${cur.session_id}`, method: cur.method, anchor_media_s: Number(cur.anchor_media_s), anchor_at: cur.anchor_at ?? undefined, anchor_period: cur.anchor_period ?? 1, anchor_clock_s: cur.anchor_clock_s ?? 0, lag_s: Number(cur.lag_s) } : { method: 'wall_clock', lag_s: 0, anchor_period: 1, anchor_clock_s: 0 }}
        fields={[
          { key: 'target', label: t('clips.game_or_session'), type: 'choice', options: targets },
          { key: 'method', label: ' ', type: 'chips', options: [{ value: 'wall_clock', label: t('clips.method_wall') }, { value: 'game_clock', label: t('clips.method_game') }] },
          { key: 'anchor_media_s', label: t('clips.anchor_media'), type: 'stepper', min: 0, max: 86400, default: 0 },
          { key: 'anchor_at', label: t('clips.anchor_at'), type: 'datetime', show: (v) => v.method !== 'game_clock' },
          { key: 'anchor_period', label: t('clips.anchor_period'), type: 'stepper', min: 0, max: 12, default: 1, show: (v) => v.method === 'game_clock' },
          { key: 'anchor_clock_s', label: t('clips.anchor_clock'), type: 'stepper', min: 0, max: 14400, default: 0, show: (v) => v.method === 'game_clock' },
          { key: 'lag_s', label: t('clips.lag'), type: 'stepper', min: 0, max: 120, default: 0, show: (v) => v.method !== 'game_clock' },
        ]}
        onSubmit={async (v) => {
          const [kind, ref] = String(v.target).split(':');
          await api.post(`/media/assets/${src}/clip-alignment`, { ...(kind === 'f' ? { fixture_id: ref } : { session_id: ref }), method: v.method, anchor_media_s: v.anchor_media_s, ...(v.method === 'game_clock' ? { anchor_period: v.anchor_period, anchor_clock_s: v.anchor_clock_s } : { anchor_at: v.anchor_at, lag_s: v.lag_s }) });
          al.reload();
          return t('clips.align_saved');
        }} />
      <FormSheet visible={bmForm} onClose={() => setBmForm(false)} title={t('clips.bookmark')}
        fields={[{ key: 'target', label: t('clips.game_or_session'), type: 'choice', options: targets }, { key: 'label', label: t('clips.title_label'), optional: true }]}
        onSubmit={async (v) => {
          const [kind, ref] = String(v.target).split(':');
          await api.post('/clip-bookmarks', { ...(kind === 'f' ? { fixture_id: ref } : { session_id: ref }), label: v.label || undefined, client_key: `ui-${Date.now()}` });
          return t('clips.bookmarked');
        }} />
      {open ? <ClipSheet id={open} onClose={() => setOpen(null)} onChanged={reload} /> : null}
      {reel ? <ReelSheet eventId={id} reel={reel.reel} clips={(q.items ?? []).filter((c) => ['approved', 'published'].includes(c.status))} games={games} onClose={() => setReel(null)} onChanged={reels.reload} /> : null}
    </>
  );
}

/** One clip: its citation, the window with ±1s trimming, title and caption (facts kept apart from prose), people, and the next workflow step. */
function ClipSheet({ id, onClose, onChanged }) {
  const { toast } = useSession();
  const d = useLoad(() => api.get(`/clips/${id}`), [id]);
  const [edit, setEdit] = useState(null);
  const [audience, setAudience] = useState('public');
  const [why, setWhy] = useState(false);
  const [busy, setBusy] = useState(false);
  const c = d.data;
  const e = edit ?? (c ? { title: c.title ?? '', prose: c.caption.prose ?? '', start: Number(c.media.start_s), end: Number(c.media.end_s), people: c.participants.map((p) => p.user_id) } : null);
  const upd = (k, v) => setEdit({ ...e, [k]: v });
  const run = async (fn, msg) => { setBusy(true); try { await fn(); if (msg) toast(msg); setEdit(null); await d.reload(); onChanged(); } catch (x) { toast(x.message); } finally { setBusy(false); } };
  if (!c) return <Sheet visible onClose={onClose} title={t('clips.title')}>{d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : <Loading />}</Sheet>;
  const editable = !['published', 'processing'].includes(c.status);
  const dirty = !!edit;
  const save = () => api.post(`/clips/${id}`, { row_version: c.row_version, title: e.title || undefined, caption_prose: e.prose || null, media_start_s: e.start, media_end_s: e.end, participants: e.people });
  const facts = c.caption.facts ?? {};
  const factLine = [momentName(c.moment_kind, c.label), facts.team, facts.minute, facts.fixture].filter(Boolean).join(' · ');
  return (
    <Sheet visible onClose={onClose} title={c.title ?? momentName(c.moment_kind, c.label)}>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <ATag label={t(`clips.st.${c.status}`)} tone={TONE[c.status]} />
          <ATag label={t(`clips.cite.${c.cites.kind}`)} tone={A.cyan} />
          {c.rights?.state ? <ATag label={stateName(c.rights.state)} tone={c.rights.state === 'live' ? A.green : A.orange} /> : null}
        </View>
        <ACard pad={12}><AT size={12} weight="800" color={A.mute}>{t('clips.facts_head').toUpperCase()}</AT><AT size={14}>{factLine}</AT><AT size={12} color={A.mute}>{t('clips.window', { from: secs(c.media.start_s), to: secs(c.media.end_s) })}</AT></ACard>
        {c.status === 'failed' && c.last_error ? <ErrorBox error={new Error(c.last_error)} /> : null}
        {editable ? (
          <>
            {c.link
              ? <VideoScrubber uri={c.link} inPoint={e.start} outPoint={e.end} durationSeconds={Math.max(c.media.end_s, e.end) + 30} onInChange={(v) => upd('start', v)} onOutChange={(v) => upd('end', v)} title={c.title} />
              : <View style={{ flexDirection: 'row', gap: 12 }}>
                  <AStepper label={t('clips.trim_start')} value={e.start} min={0} max={86400} onChange={(v) => upd('start', v)} />
                  <AStepper label={t('clips.trim_end')} value={e.end} min={1} max={86400} onChange={(v) => upd('end', v)} />
                </View>}
            <Field label={t('clips.title_label')} value={e.title} onChangeText={(v) => upd('title', v)} maxLength={140} />
            <Field label={t('clips.caption_label')} value={e.prose} onChangeText={(v) => upd('prose', v)} multiline maxLength={500} />
            {c.caption.prose_by_ai && !dirty ? <ATag label={t('clips.ai_drafted')} tone={A.sun} /> : null}
            <MultiMenuField label={t('clips.people')} value={e.people} onChange={(v) => upd('people', v)} load={peopleLoader} options={c.participants.map((p) => ({ value: p.user_id, label: p.display_name }))} placeholder={t('clips.no_people')} />
          </>
        ) : (
          <>
            {c.caption.prose ? <><AT size={14}>{c.caption.prose}</AT>{c.caption.prose_by_ai ? <ATag label={t('clips.ai_drafted')} tone={A.sun} /> : null}</> : null}
            {c.participants.map((p) => <AT key={p.user_id} size={13} color={A.mute}>{p.display_name}</AT>)}
          </>
        )}
        <View style={{ gap: 10 }}>
          {editable && dirty ? <ABtn title={t('common.save')} loading={busy} onPress={() => run(save, t('clips.saved'))} /> : null}
          {editable && c.asset_id ? <ABtn small tone="ghost" title={t('clips.draft_caption')} loading={busy} disabled={dirty} onPress={() => run(() => api.post(`/clips/${id}/caption-draft`, { row_version: c.row_version }))} /> : null}
          {['candidate', 'failed'].includes(c.status) ? <ABtn tone="neon" title={t('clips.cut')} loading={busy} disabled={dirty} onPress={() => run(() => api.post(`/clips/${id}/process`), t('clips.cut_started'))} /> : null}
          {c.status === 'processing' ? <ABtn small tone="ghost" title={t('common.retry')} onPress={() => d.reload()} /> : null}
          {c.status === 'review' ? <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            <ABtn tone="lime" title={t('clips.approve')} loading={busy} disabled={dirty} onPress={() => run(() => api.post(`/clips/${id}/review`, { decision: 'approve', row_version: c.row_version }))} />
            <ABtn tone="ghost" title={t('clips.reject')} disabled={dirty} onPress={() => run(() => api.post(`/clips/${id}/review`, { decision: 'reject', row_version: c.row_version }))} />
          </View> : null}
          {c.status === 'approved' ? (
            <>
              <AT size={12} weight="800" color={A.mute}>{t('clips.audience').toUpperCase()}</AT>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <AChip label={t('clips.aud.public')} active={audience === 'public'} onPress={() => setAudience('public')} />
                <AChip label={t('clips.aud.licensed')} active={audience === 'licensed'} onPress={() => setAudience('licensed')} />
              </View>
              <ABtn tone="lime" title={t('clips.publish')} loading={busy} onPress={() => run(() => api.post(`/clips/${id}/publish`, { audience }), t('clips.st.published'))} />
            </>
          ) : null}
          {c.status === 'published' ? <ABtn tone="live" title={t('clips.withdraw')} onPress={() => setWhy(true)} /> : null}
          {c.link ? <ABtn small tone="ghost" title={t('clips.watch')} onPress={() => WebBrowser.openBrowserAsync(c.link)} /> : null}
          {c.asset_id && c.participants.length && ['review', 'approved', 'published'].includes(c.status)
            ? c.participants.map((p) => <ABtn key={p.user_id} small tone="ghost" title={`${t('clips.offer_player')} · ${p.display_name}`} onPress={() => run(() => api.post(`/clips/${id}/player-links`, { user_id: p.user_id }), t('clips.offer_sent'))} />) : null}
        </View>
      </View>
      <ReasonSheet visible={why} onClose={() => setWhy(false)} title={t('clips.withdraw')} sub={t('clips.withdraw_why')} confirmLabel={t('clips.withdraw')} onConfirm={(reason) => run(() => api.post(`/clips/${id}/withdraw`, { reason }))} />
    </Sheet>
  );
}

/** A reel: approved clips in order, with intro / outro / scorecard cards and sponsor bumpers backed by real confirmed inventory bookings. */
function ReelSheet({ eventId, reel, clips, games, onClose, onChanged }) {
  const { toast } = useSession();
  const [items, setItems] = useState(() => (reel?.items ?? []).map((i) => ({ id: i.id ?? undefined, kind: i.kind, candidate_id: i.candidate_id ?? undefined, inventory_booking_id: i.inventory_booking_id ?? undefined, label: i.label ?? undefined, title: i.clip_title, frame_url: i.frame_url ?? undefined, frame_data: i.frame_data ?? undefined })));
  const [title, setTitle] = useState(reel?.title ?? '');
  const [game, setGame] = useState(reel?.fixture_id ?? null);
  const [busy, setBusy] = useState(false);
  const inv = useLoad(() => api.get('/sponsor-inventory', { target_type: 'event', target_id: eventId }).catch(() => ({ units: [] })), [eventId]);
  const bookings = useMemo(() => (inv.data?.units ?? []).filter((u) => ['livestream_overlay', 'replay', 'scorecard'].includes(u.kind)).flatMap((u) => (u.bookings ?? []).filter((b) => b.status === 'confirmed').map((b) => ({ value: b.id, label: `${u.name} · ${b.sponsor_name}` }))), [inv.data]);
  const clipOpts = clips.map((c) => ({ value: c.id, label: c.title ?? momentName(c.moment_kind, c.label) }));
  const inReel = items.filter((i) => i.kind === 'clip').map((i) => i.candidate_id);
  const move = (n, d) => setItems((a) => { const b = [...a]; const j = n + d; if (j < 0 || j >= b.length) return a; [b[n], b[j]] = [b[j], b[n]]; return b; });
  const body = () => items.map(({ kind, candidate_id, inventory_booking_id, label }) => ({ kind, candidate_id, inventory_booking_id, label }));
  const run = async (fn, msg) => { setBusy(true); try { await fn(); if (msg) toast(msg); onChanged(); onClose(); } catch (x) { toast(x.message); } finally { setBusy(false); } };
  const save = () => (reel
    ? api.post(`/reels/${reel.id}`, { row_version: reel.row_version, title, items: body() })
    : api.post(`/events/${eventId}/reels`, { kind: game ? 'match' : 'event', fixture_id: game ?? undefined, title, items: body() }));
  const label = (i) => (i.kind === 'clip' ? (i.title ?? clipOpts.find((o) => o.value === i.candidate_id)?.label ?? '') : t(`clips.card.${i.kind}`));
  return (
    <Sheet visible onClose={onClose} title={reel ? reel.title : t('clips.reel_new')}>
      <View style={{ gap: 12 }}>
        <Field label={t('clips.reel_title')} value={title} onChangeText={setTitle} maxLength={140} />
        {!reel ? <MenuField label={t('clips.reel_game')} value={game} onChange={setGame} options={games.slice(0, 60).map((g) => ({ value: g.id, label: `${g.home?.name ?? g.home_name ?? '–'} v ${g.away?.name ?? g.away_name ?? '–'}` }))} placeholder={t('common.all')} /> : null}
        {items.map((i, n) => (
          <View key={`${i.kind}-${n}`} style={{ gap: 6 }}>
            <ARow title={label(i)} sub={i.kind === 'sponsor_bumper' ? bookings.find((o) => o.value === i.inventory_booking_id)?.label : undefined}
              right={reel?.status === 'published' ? undefined : <View style={{ flexDirection: 'row', gap: 6 }}>
                <ABtn small tone="ghost" title="↑" onPress={() => move(n, -1)} /><ABtn small tone="ghost" title="↓" onPress={() => move(n, 1)} /><ABtn small tone="ghost" title="✕" onPress={() => setItems((a) => a.filter((_, k) => k !== n))} />
              </View>} />
            {i.frame_url ? <Image source={{ uri: i.frame_url }} style={{ width: '100%', height: 100, borderRadius: 8 }} resizeMode="contain" accessibilityLabel={t('clips.frame.preview')} /> : null}
            {reel?.id && i.kind === 'scorecard' && reel.status !== 'published'
              ? <ABtn small tone="ghost" title={i.frame_url ? t('clips.frame.refresh') : t('clips.frame.generate')} loading={busy} onPress={() => run(async () => { const f = await api.post(`/reels/${reel.id}/scorecard-frame`); setItems((a) => a.map((x, k) => k === n ? { ...x, frame_url: f.frame_url } : x)); }, t('clips.frame.generate'))} /> : null}
            {reel?.id && i.kind === 'sponsor_bumper' && i.inventory_booking_id && reel.status !== 'published'
              ? <ABtn small tone="ghost" title={i.frame_url ? t('clips.frame.refresh') : t('clips.frame.generate')} loading={busy} onPress={() => run(async () => { const f = await api.post(`/reels/${reel.id}/items/${i.id}/bumper-frame`); setItems((a) => a.map((x, k) => k === n ? { ...x, frame_url: f.frame_url, frame_data: { sponsor_name: f.sponsor_name, logo_url: f.logo_url } } : x)); }, t('clips.frame.generate'))} /> : null}
          </View>
        ))}
        {reel?.status !== 'published' ? (
          <>
            <MultiMenuField label={t('clips.reel_clips')} value={inReel} options={clipOpts} placeholder={t('common.choose')} onChange={(ids) => setItems((a) => [...a.filter((i) => i.kind !== 'clip' || ids.includes(i.candidate_id)), ...ids.filter((x) => !inReel.includes(x)).map((x) => ({ kind: 'clip', candidate_id: x, title: clipOpts.find((o) => o.value === x)?.label }))])} />
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {['intro', 'outro', 'scorecard'].map((k) => <AChip key={k} label={`+ ${t(`clips.card.${k}`)}`} onPress={() => setItems((a) => (k === 'intro' ? [{ kind: k }, ...a] : [...a, { kind: k }]))} />)}
            </View>
            {bookings.length
              ? <MenuField label={t('clips.reel_bumper_pick')} value={null} options={bookings} placeholder={`+ ${t('clips.card.sponsor_bumper')}`} onChange={(b) => b && setItems((a) => [...a, { kind: 'sponsor_bumper', inventory_booking_id: b }])} />
              : <AT size={12} color={A.mute}>{t('clips.reel_no_booking')}</AT>}
            <ABtn title={t('common.save')} loading={busy} disabled={title.trim().length < 2} onPress={() => run(save, t('clips.saved'))} />
          </>
        ) : null}
        {reel && reel.status !== 'published' ? <ABtn tone="lime" title={t('clips.reel_publish')} loading={busy} onPress={() => run(async () => { const r = await save().then(() => api.get(`/events/${eventId}/reels`)); const fresh = r.items.find((x) => x.id === reel.id); await api.post(`/reels/${reel.id}/status`, { action: 'publish', row_version: fresh.row_version }); }, t('clips.st.published'))} /> : null}
        {reel?.status === 'published' ? <ABtn tone="live" title={t('clips.reel_withdraw')} loading={busy} onPress={() => run(() => api.post(`/reels/${reel.id}/status`, { action: 'withdraw', row_version: reel.row_version }))} /> : null}
      </View>
    </Sheet>
  );
}
