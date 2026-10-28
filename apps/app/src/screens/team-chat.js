import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Platform, Pressable, TextInput, View } from 'react-native';
import { api } from '../api';
import { useSession } from '../session';
import { useLoad } from '../hooks';
import { Avatar, Btn, Card, Chip, Empty, ErrorBox, H1, Loading, Screen, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { c, fam, when } from '../theme';
import { locale } from '../locale';
import { useTeamChat } from '../team-chat-live';
import { VoicePlayer, VoiceRecorderSheet } from '../voice-note';
import { pickDocument } from './insurance';
import { openPdf } from '../open-file';

const clock = (iso) => new Date(iso).toLocaleString(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const EMOJI = ['👍', '❤️', '😂', '🙌', '🔥', '😮'];
const LINK_LABEL = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…', revoked: 'No access' };
const newId = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** A protected picture (it needs the sign-in header, so it is fetched, then shown from a local URL). */
function ProtectedImage({ media }) {
  const [uri, setUri] = useState(null);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    let live = true, url = null;
    (async () => {
      try {
        const blob = await api.download(media.url.replace('/api/v1', ''));
        if (!live) return;
        if (Platform.OS === 'web') { url = URL.createObjectURL(blob); setUri(url); return; }
        const reader = new FileReader();
        reader.onloadend = () => { if (live) setUri(reader.result); };
        reader.readAsDataURL(blob);
      } catch { if (live) setBad(true); }
    })();
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [media.url]);
  if (bad) return <T color={c.mute}>Picture unavailable</T>;
  if (!uri) return <View style={{ width: 220, height: 150, borderRadius: 12, backgroundColor: c.violetSoft }} accessibilityLabel="Loading picture" />;
  return <Image source={{ uri }} accessibilityLabel={media.name || 'Photo from the team chat'} style={{ width: 220, height: 160, borderRadius: 12 }} resizeMode="cover" />;
}

function Attachment({ media }) {
  const { toast } = useSession();
  if (media.kind === 'image') return <ProtectedImage media={media} />;
  if (media.kind === 'voice') return <VoicePlayer media={media} />;
  return <Btn small color={c.paper} ink={c.ink} title={`📎 ${media.name}`} accessibilityLabel={`Open file ${media.name}`} onPress={() => openPdf(media.url.replace('/api/v1', ''), media.name).catch((e) => toast(e.message))} />;
}

const bar = (pct, color) => (
  <View style={{ height: 8, borderRadius: 4, backgroundColor: c.line, overflow: 'hidden' }}><View style={{ height: 8, width: `${pct}%`, backgroundColor: color }} /></View>
);

function PollCard({ m, teamId, onChange }) {
  const { toast } = useSession();
  const p = m.poll;
  const total = Math.max(1, p.options.reduce((t, o) => t + o.votes, 0));
  const vote = async (opt) => {
    const mine = p.options.filter((o) => o.mine).map((o) => o.option_id);
    const next = p.multiple ? (opt.mine ? mine.filter((x) => x !== opt.option_id) : [...mine, opt.option_id]) : (opt.mine ? [] : [opt.option_id]);
    try { onChange(await api.post(`/teams/${teamId}/polls/${m.message_id}/vote`, { option_ids: next })); } catch (e) { toast(e.message); }
  };
  return (
    <View style={{ gap: 8 }}>
      <T weight="800">📊 {p.question}</T>
      <T size={12} color={c.mute}>{p.multiple ? 'Pick any' : 'Pick one'} · {p.voters} voted{p.closed ? ' · closed' : ''}</T>
      {p.options.map((o) => (
        <Pressable key={o.option_id} disabled={p.closed} onPress={() => vote(o)} accessibilityRole="button" accessibilityLabel={`${o.label}, ${o.votes} votes${o.mine ? ', your vote' : ''}`} accessibilityState={{ selected: o.mine, disabled: p.closed }}
          style={{ minHeight: 44, justifyContent: 'center', gap: 4, padding: 8, borderRadius: 12, borderWidth: 1.5, borderColor: o.mine ? c.pink : c.line }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T weight={o.mine ? '800' : '600'}>{o.mine ? '✓ ' : ''}{o.label}</T><T color={c.mute}>{o.votes}</T></View>
          {bar(Math.round((o.votes / total) * 100), o.mine ? c.pink : c.cyan)}
        </Pressable>
      ))}
    </View>
  );
}

function RsvpCard({ m, teamId, onChange }) {
  const { toast } = useSession();
  const r = m.rsvp;
  const answer = async (rsvp) => {
    try {
      await api.post(`/teams/${teamId}/attendance`, { event_id: r.fixture_id ? undefined : r.event_id, fixture_id: r.fixture_id ?? undefined, rsvp });
      onChange();
    } catch (e) { toast(e.message); }
  };
  return (
    <View style={{ gap: 8 }}>
      <T weight="800">📅 Are you coming?{r.name ? ` · ${r.name}` : ''}</T>
      {r.at ? <T size={12} color={c.mute}>{when(r.at)}</T> : null}
      {m.body ? <T>{m.body}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {[['going', '✅ Going'], ['maybe', '🤔 Maybe'], ['no', '🚫 Can’t']].map(([k, l]) => <Chip key={k} label={`${l} · ${r.counts[k]}`} active={r.mine === k} onPress={() => answer(k)} />)}
      </View>
      <T size={12} color={c.mute}>{r.counts.pending} haven’t answered · answers live in the team schedule</T>
    </View>
  );
}

export function TeamChat({ id }) {
  const { toast } = useSession();
  const team = useLoad(() => api.get(`/teams/${id}`), [id]);
  const ws = useLoad(() => api.get(`/teams/${id}/workspace`).catch(() => null), [id]);
  const chat = useTeamChat(id);
  const { msgs, more, link, merge } = chat;
  const [channel, setChannel] = useState('team');
  const [text, setText] = useState('');
  const [announce, setAnnounce] = useState(false);
  const [reply, setReply] = useState(null);
  const [sending, setSending] = useState(false);
  const [menu, setMenu] = useState(null);
  const [attach, setAttach] = useState(false);
  const [poll, setPoll] = useState(false);
  const [rsvp, setRsvp] = useState(false);
  const [voice, setVoice] = useState(false);
  const attempt = useRef(null);   // the client id of an unsent message: a retry after a dropped connection reuses it, so it can never post twice

  const t = team.data;
  const canManage = !!t?.can_manage;
  const channels = useMemo(() => {
    const seen = new Set((msgs ?? []).map((m) => m.audience));
    const guardian = !t?.my_membership && !canManage;   // a guardian who is not on the team only has the guardians channel
    return [...(guardian ? [] : ['team']), ...(canManage || seen.has('guardians') || guardian ? ['guardians'] : [])];
  }, [msgs, t, canManage]);
  const active = channels.includes(channel) ? channel : channels[0] ?? 'team';
  const visible = (msgs ?? []).filter((m) => m.audience === active);
  const pinned = visible.filter((m) => m.pinned_at).sort((a, b) => b.pinned_at.localeCompare(a.pinned_at))[0];

  useEffect(() => { if (msgs?.length) chat.markRead(); }, [msgs?.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (chat.error || team.error) return <Screen><ErrorBox error={chat.error ?? team.error} onRetry={() => { chat.retry(); team.reload(); }} /></Screen>;
  if (!msgs || !t) return <Screen><Loading /></Screen>;
  if (link === 'revoked') return <Screen><Empty emoji="🔒" title="You no longer have access to this chat" sub="Team access ended. Your own messages stay with the team." /></Screen>;

  const post = async (extra = {}) => {
    const body = (extra.body ?? text).trim();
    if (sending || (!body && !extra.media_id)) return;
    setSending(true);
    attempt.current ??= newId();
    try {
      const m = await api.post(`/teams/${id}/messages`, { body, announcement: announce && active === 'team', audience: active, reply_to_id: reply?.message_id, client_id: attempt.current, ...extra });
      attempt.current = null; setText(''); setAnnounce(false); setReply(null); merge([m]);
    } catch (e) { toast(e.message); } finally { setSending(false); }
  };
  const upload = async (kind, blob, name, seconds) => {
    const row = await api.upload(`/teams/${id}/chat-media`, blob, { kind, name, audience: active, seconds });
    await post({ body: '', media_id: row.media_id });
  };
  const pickPhotoOrFile = async () => {
    setAttach(false);
    try {
      const f = await pickDocument();
      if (!f) return;
      const type = f.blob.type || '';
      await upload(type.startsWith('image/') || !type ? 'image' : 'file', f.blob, f.name || 'attachment');
    } catch (e) {
      // pickDocument offers photos and PDFs; a PDF is sent as a file, a picture as a photo
      if (/Unsupported photo/.test(e.message)) toast('That file type is not supported. Use a photo or a PDF.'); else toast(e.message);
    }
  };
  const act = async (fn) => { setMenu(null); try { const r = await fn(); if (r?.message_id) merge([r]); } catch (e) { toast(e.message); } };
  const loadOlder = () => chat.loadOlder(active).catch((e) => toast(e.message));
  const options = [
    ...(ws.data?.schedule.events ?? []).map((e) => ({ value: `e:${e.event_id}`, label: `🏆 ${e.name}${e.starts_on ? ` · ${String(e.starts_on).slice(0, 10)}` : ''}` })),
    ...(ws.data?.schedule.fixtures ?? []).map((f) => ({ value: `f:${f.fixture_id}`, label: `⚽ ${f.home_name ?? 'TBC'} vs ${f.away_name ?? 'TBC'} · ${when(f.scheduled_at)}` })),
  ];

  return (
    <Screen>
     <View style={{ width: '100%', maxWidth: 760, alignSelf: 'center' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <H1 style={{ flex: 1 }}>{t.emoji} {t.name}</H1>
        <Tag label={`● ${LINK_LABEL[link]}`} color={link === 'live' ? c.mintSoft : c.sunSoft} />
      </View>
      <T color={c.mute} weight="700">{active === 'guardians' ? 'Guardians channel · managers and guardians of young members' : 'Team chat · only members can see this'}</T>
      {channels.length > 1 ? <View style={{ marginTop: 10 }}><Seg value={active} onChange={setChannel} options={[['team', 'Team'], ['guardians', 'Guardians']].filter(([k]) => channels.includes(k)).map(([value, label]) => ({ value, label }))} /></View> : null}
      {pinned ? (
        <Card color={c.sunSoft} pad={10} style={{ marginTop: 10 }}>
          <T size={12} weight="800" color={c.ink}>📌 Pinned</T><T numberOfLines={2}>{pinned.body || pinned.poll?.question || 'Attachment'}</T>
        </Card>
      ) : null}
      {more ? <Btn small title="Earlier messages" color={c.paper} ink={c.ink} onPress={loadOlder} style={{ marginTop: 10 }} /> : null}
      <View style={{ gap: 10, marginTop: 12 }}>
        {visible.length ? visible.map((m) => (
          <View key={m.message_id} style={{ flexDirection: 'row', gap: 8, justifyContent: m.mine ? 'flex-end' : 'flex-start' }}>
            {m.mine ? null : <Avatar user={m} size={32} />}
            <Pressable onLongPress={() => setMenu(m)} style={{ maxWidth: '82%' }} accessibilityLabel={`${m.mine ? 'You' : m.display_name}: ${m.body || m.poll?.question || 'attachment'}. Double tap and hold for options.`}>
              <Card color={m.announcement ? c.sunSoft : m.mine ? c.violetSoft : c.paper} pad={10}>
                <View style={{ gap: 6 }}>
                  {m.announcement ? <Tag label="📣 Announcement" style={{ alignSelf: 'flex-start' }} /> : null}
                  {m.mine ? null : <T size={12} weight="800" color={c.violet}>{m.display_name}</T>}
                  {m.reply_to ? <View style={{ borderLeftWidth: 3, borderColor: c.pink, paddingLeft: 8 }}><T size={11} weight="800" color={c.mute}>{m.reply_to.display_name}</T><T size={12} color={c.mute} numberOfLines={2}>{m.reply_to.body ?? 'Message removed'}</T></View> : null}
                  {m.kind === 'poll' && m.poll ? <PollCard m={m} teamId={id} onChange={(r) => merge([r])} /> : null}
                  {m.kind === 'rsvp' && m.rsvp ? <RsvpCard m={m} teamId={id} onChange={() => api.get(`/teams/${id}/messages`, { limit: 20 }).then(merge).catch(() => {})} /> : null}
                  {m.media ? <Attachment media={m.media} /> : null}
                  {m.kind === 'text' || m.kind === 'media' ? (m.body ? <T>{m.body}</T> : null) : null}
                  {m.reactions.length ? (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      {m.reactions.map((r) => (
                        <Pressable key={r.emoji} onPress={() => act(() => api.post(`/teams/${id}/messages/${m.message_id}/reactions`, { emoji: r.emoji, on: !r.mine }))} accessibilityRole="button" accessibilityLabel={`${r.emoji} ${r.count}${r.mine ? ', you reacted' : ''}`}
                          style={{ minHeight: 32, paddingHorizontal: 10, borderRadius: 16, justifyContent: 'center', backgroundColor: r.mine ? c.pinkSoft : c.violetSoft }}><T size={13} weight="700">{r.emoji} {r.count}</T></Pressable>
                      ))}
                    </View>
                  ) : null}
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <T size={11} color={c.mute} style={{ flex: 1 }}>{clock(m.created_at)}{m.pinned_at ? ' · 📌' : ''}{m.delivery ? ` · ${m.delivery.read_by ? `Read by ${m.delivery.read_by}` : 'Delivered'}` : ''}</T>
                    <Pressable onPress={() => setMenu(m)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Message options" style={{ width: 44, height: 32, alignItems: 'center', justifyContent: 'center' }}><T weight="800" color={c.mute}>⋯</T></Pressable>
                  </View>
                </View>
              </Card>
            </Pressable>
          </View>
        )) : <Empty emoji="💬" title="No messages yet" sub={active === 'guardians' ? 'Start a conversation with the other guardians.' : 'Say hello to your team.'} />}
      </View>

      <View style={{ marginTop: 14, gap: 8 }}> 
        {reply ? <Card color={c.violetSoft} pad={8}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><T size={12} style={{ flex: 1 }} numberOfLines={1}>↩︎ Replying to {reply.display_name}: {reply.body || 'attachment'}</T><Pressable onPress={() => setReply(null)} accessibilityLabel="Cancel reply" hitSlop={10} style={{ width: 44, height: 32, alignItems: 'center', justifyContent: 'center' }}><T>✕</T></Pressable></View></Card> : null}
        <TextInput value={text} onChangeText={setText} placeholder={active === 'guardians' ? 'Message the guardians' : 'Message your team'} placeholderTextColor="#94A3B8" multiline maxLength={2000} accessibilityLabel="Message"
          style={[fam, { borderWidth: 1, borderColor: c.line, borderRadius: 14, padding: 12, minHeight: 48, backgroundColor: c.paper, color: c.ink }]} />
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Btn small title="＋" color={c.paper} ink={c.ink} onPress={() => setAttach(true)} accessibilityLabel="Attach, poll or ask who is coming" />
          {canManage && active === 'team' ? <Chip label={announce ? '📣 Announcement — notifies everyone ✓' : '📣 Make it an announcement'} active={announce} onPress={() => setAnnounce(!announce)} /> : null}
          <View style={{ flex: 1 }} />
          <Btn small title="Send" onPress={() => post()} loading={sending} disabled={!text.trim()} />
        </View>
      </View>

      <Sheet visible={!!menu} onClose={() => setMenu(null)} title="Message">
        {menu ? (
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {EMOJI.map((e) => <Pressable key={e} onPress={() => act(() => api.post(`/teams/${id}/messages/${menu.message_id}/reactions`, { emoji: e, on: !menu.reactions.find((r) => r.emoji === e)?.mine }))} accessibilityRole="button" accessibilityLabel={`React ${e}`} style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: c.violetSoft }}><T size={22}>{e}</T></Pressable>)}
            </View>
            <Btn title="↩︎ Reply" color={c.paper} ink={c.ink} onPress={() => { setReply(menu); setMenu(null); }} />
            {canManage ? <Btn title={menu.pinned_at ? 'Unpin' : '📌 Pin to the top'} color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/teams/${id}/messages/${menu.message_id}/pin`, { pinned: !menu.pinned_at }))} /> : null}
            {menu.kind === 'poll' && menu.poll && !menu.poll.closed && (menu.mine || canManage) ? <Btn title="Close poll" color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/teams/${id}/polls/${menu.message_id}/close`))} /> : null}
            {menu.mine || canManage ? <Btn title="Delete" color={c.red} onPress={() => act(async () => { await api.del(`/teams/${id}/messages/${menu.message_id}`); merge([], [menu.message_id]); })} /> : null}
          </View>
        ) : null}
      </Sheet>

      <Sheet visible={attach} onClose={() => setAttach(false)} title="Add to the chat">
        <View style={{ gap: 10 }}>
          <Btn title="📷 Photo or PDF" color={c.paper} ink={c.ink} onPress={pickPhotoOrFile} />
          <Btn title="🎙️ Voice note" color={c.paper} ink={c.ink} onPress={() => { setAttach(false); setVoice(true); }} />
          <Btn title="📊 Poll" color={c.paper} ink={c.ink} onPress={() => { setAttach(false); setPoll(true); }} />
          {canManage && active === 'team' ? <Btn title="📅 Ask who is coming" color={c.paper} ink={c.ink} onPress={() => { setAttach(false); setRsvp(true); }} /> : null}
          <T size={12} color={c.mute}>“Who is coming” asks through the team schedule, so answers are never stored twice.</T>
        </View>
      </Sheet>

      {voice ? <VoiceRecorderSheet onClose={() => setVoice(false)} onDone={({ blob, seconds, name }) => upload('voice', blob, name, seconds)} /> : null}

      <FormSheet visible={poll} onClose={() => setPoll(false)} title="New poll" submitLabel="Post poll"
        fields={[
          { key: 'question', label: 'Question' },
          { key: 'option1', label: 'Option 1' }, { key: 'option2', label: 'Option 2' }, { key: 'option3', label: 'Option 3', optional: true }, { key: 'option4', label: 'Option 4', optional: true },
          { key: 'multiple', label: 'Allow more than one choice', type: 'switch' },
          { key: 'closes_at', label: 'Closes', type: 'datetime', optional: true, hint: 'Leave empty to keep it open until you close it.' },
        ]}
        initial={{ multiple: false }}
        onSubmit={async (v) => { merge([await api.post(`/teams/${id}/polls`, { question: v.question, options: [v.option1, v.option2, v.option3, v.option4].filter(Boolean), multiple: !!v.multiple, closes_at: v.closes_at, audience: active, client_id: newId() })]); return 'Poll posted'; }} />

      <FormSheet visible={rsvp} onClose={() => setRsvp(false)} title="Ask who is coming" submitLabel="Ask the team"
        fields={[
          { key: 'scope', label: 'Event or match', type: 'chips', options },
          { key: 'squad_only', label: 'Only the selected squad', type: 'switch' },
          { key: 'note', label: 'Note', type: 'multiline', optional: true },
        ]}
        initial={{ squad_only: false }}
        onSubmit={async (v) => {
          const [kind, ref] = String(v.scope).split(':');
          merge([await api.post(`/teams/${id}/rsvp-prompts`, { [kind === 'f' ? 'fixture_id' : 'event_id']: ref, squad_only: !!v.squad_only, note: v.note ?? '' })]);
          return 'Asked the team';
        }} />
     </View>
    </Screen>
  );
}
