// The Unified Inbox (issue #594): one list for team chats, notifications and conversations (direct, group, event channel, threads about a team /
// fixture / registration), with the conversation beside it on tablets and desktops and as its own screen on phones. The same React Native code
// runs on iOS, iPadOS, Android and web. Every rule (who may read, post, add, report) is enforced by the API; this screen only asks and shows.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { api } from '../api';
import { useSession } from '../session';
import { openLink, useNav } from '../nav';
import { useLayout } from '../layout';
import { useLoad } from '../hooks';
import { Avatar, Btn, Chip, ErrorBox, Field, HScroll, Loading, Screen, Seg, Sheet, T, Tag } from '../ui';
import { EntityPicker } from '../entity-picker';
import { TimeField } from '../pickers';
import { c } from '../theme';
import { locale } from '../locale';
import { pickDocument } from './insurance';
import { ProtectedImage } from './team-chat';
import { openPdf } from '../open-file';

const FILTERS = [['all', 'All'], ['teams', 'Teams'], ['events', 'Events'], ['direct', 'Direct'], ['announcements', 'Announcements'], ['alerts', 'Alerts'], ['archived', 'Archived']];
const REASONS = [['abuse', 'Abuse'], ['harassment', 'Harassment'], ['unsafe_contact', 'Unsafe contact'], ['spam', 'Spam'], ['privacy', 'Privacy'], ['other', 'Something else']];
const stamp = (iso) => {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (now - d < 6 * 864e5) return d.toLocaleDateString(locale, { weekday: 'short' });
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
};
const newKey = () => `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
// One calm palette: amethyst for what is yours to read, slate for structure, amber only for something that needs an answer. Surfaces are tints of the
// theme, never white cards, so the inbox sits on the canvas like the rest of the app.
const tint = (col, a = '14') => `${col}${a}`;
const initial = (t) => (String(t ?? '?').trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();

/** A quiet panel: a hairline and a faint tint of the theme instead of a white card. */
const Panel = ({ children, style, tone = c.violet, strong }) => <View style={[{ borderRadius: 18, borderWidth: 1, borderColor: tint(c.violet, '26'), backgroundColor: tint(tone, strong ? '1F' : '0D'), padding: 14 }, style]}>{children}</View>;
const Note = ({ children }) => <View style={{ borderRadius: 12, backgroundColor: tint(c.pink, '1A'), paddingVertical: 10, paddingHorizontal: 12 }}><T size={13}>{children}</T></View>;
const Quiet = ({ title, sub }) => <View style={{ alignItems: 'center', gap: 4, paddingVertical: 28, paddingHorizontal: 16 }}><T weight="700" size={15}>{title}</T>{sub ? <T size={13} color={c.mute} style={{ textAlign: 'center' }}>{sub}</T> : null}</View>;

// ------------------------------------------------------------------------------------------------------------------ the list
function ItemRow({ item, selected, onPress }) {
  const unread = item.unread > 0 || item.needs_ack > 0;
  const urgent = item.needs_ack > 0 || item.type === 'alert';
  const label = `${item.title}. ${item.preview ?? ''}${item.context ? `. ${item.context}` : ''}${unread ? `. ${item.needs_ack ? 'Needs your confirmation' : `${item.unread} unread`}` : ''}`;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!selected }}
      style={({ pressed }) => ({ minHeight: 64, flexDirection: 'row', gap: 12, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: selected ? c.pink : tint(c.violet, '40'), backgroundColor: selected ? tint(c.pink, '26') : pressed ? tint(c.violet, '1A') : tint(c.violet, '0D') })}>
      <View style={{ width: 44, height: 44, borderRadius: item.type === 'direct' ? 22 : 14, backgroundColor: urgent ? tint(c.sun, '2E') : tint(item.type === 'direct' ? c.pink : c.violet, '1F'), alignItems: 'center', justifyContent: 'center' }}>
        <T size={17} weight="800" color={urgent ? (c.sun) : item.type === 'direct' ? c.pink : c.violet}>{item.needs_ack || item.type === 'alert' ? '!' : initial(item.title)}</T>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <T weight={unread ? '800' : '600'} size={15} numberOfLines={1} style={{ flex: 1 }}>{item.title}</T>
          <T size={11} color={c.mute}>{stamp(item.at)}</T>
        </View>
        {item.preview ? <T size={13} color={c.mute} numberOfLines={1}>{item.last_sender && item.type !== 'direct' ? `${item.last_sender}: ` : ''}{item.preview}</T> : null}
        {item.context || item.read_only || item.muted ? <T size={11} color={c.mute} numberOfLines={1} style={{ marginTop: 2 }}>{[item.context, item.read_only ? 'Guardian view' : null, item.muted ? 'Muted' : null].filter(Boolean).join('  ·  ')}</T> : null}
      </View>
      {unread ? <View style={{ minWidth: 22, height: 22, borderRadius: 11, backgroundColor: item.needs_ack ? c.sun : c.pink, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, alignSelf: 'center' }}><T size={11} weight="800" color={item.needs_ack ? '#2A2D3A' : c.onAccent}>{item.needs_ack || item.unread}</T></View> : null}
    </Pressable>
  );
}

/** The inbox list. `split` shows the open conversation beside it (tablet and desktop); `compact` is the short version used on Home. */
export function InboxBody({ compact = false }) {
  const nav = useNav();
  const { toast } = useSession();
  const L = useLayout();
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [compose, setCompose] = useState(false);
  const searching = q.trim().length >= 2;
  const list = useLoad(() => (searching ? api.get('/inbox/search', { q: q.trim() }) : api.get('/inbox', { filter, limit: compact ? 8 : 60 })), [filter, searching ? q.trim() : '', compact]);
  useEffect(() => { const t = setInterval(() => list.reload(), 20000); return () => clearInterval(t); }, [list.reload]);
  const split = L.tablet && !compact;
  const d = list.data;

  const open = async (it) => {
    try {
      if (it.source === 'conversation') { if (split) setSel(it.conversation_id); else nav.push('Conversation', { id: it.conversation_id }); }
      else if (it.source === 'team_chat') nav.push('TeamChat', { id: it.team_id });
      else if (it.source === 'notification') {
        if (it.unread) await api.post('/notifications/read', { ids: [it.notification_id] });
        if (!openLink(nav, it.link)) list.reload();
      }
    } catch (e) { toast(e.message); }
  };
  const openResult = (r) => {
    if (r.source === 'conversation') { if (split) setSel(r.conversation_id); else nav.push('Conversation', { id: r.conversation_id }); }
    else if (r.source === 'team_chat') nav.push('TeamChat', { id: r.team_id });
  };
  const readAll = async () => { try { await api.post('/notifications/read', {}); list.reload(); } catch (e) { toast(e.message); } };

  const left = (
    <View style={{ gap: 10, flex: split ? undefined : 1 }}>
      {!compact ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <TextInput value={q} onChangeText={setQ} placeholder="Search messages, people, alerts" placeholderTextColor={c.mute} accessibilityLabel="Search the inbox"
            style={{ flex: 1, minHeight: 44, borderRadius: 22, paddingHorizontal: 16, backgroundColor: tint(c.violet, '12'), color: c.ink, fontSize: 15 }} />
          <Btn small title="New" onPress={() => setCompose(true)} accessibilityLabel="Start a new message" />
        </View>
      ) : null}
      {!searching ? (
        <HScroll>
          {FILTERS.map(([k, label]) => {
            const n = d?.unread_by_filter?.[k];
            return <Chip key={k} label={`${label}${n ? ` · ${n}` : ''}`} active={filter === k} onPress={() => setFilter(k)} />;
          })}
          {d?.unread_total ? <Chip label="Mark alerts read" onPress={readAll} /> : null}
        </HScroll>
      ) : null}
      {list.loading && !d ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : searching ? (
        d.results.length ? d.results.map((r) => (
          <Pressable key={`${r.source}${r.message_id ?? r.notification_id}`} onPress={() => openResult(r)} accessibilityRole="button" accessibilityLabel={`${r.title}. ${r.snippet}`} style={{ minHeight: 56, paddingVertical: 8, paddingHorizontal: 10 }}>
            <T weight="700">{r.title}</T><T size={13} color={c.mute} numberOfLines={2}>{r.snippet}</T>
          </Pressable>
        )) : <Quiet title="No matches" sub="Search covers your conversations, team chats and alerts. Hidden messages are never searched." />
      ) : d.items.length ? <View style={{ gap: 8 }}>{d.items.map((it) => (
        <ItemRow key={it.key} item={it} selected={sel && it.conversation_id === sel} onPress={() => open(it)} />
      ))}</View> : (
        <Quiet title={filter === 'all' ? 'Your inbox is empty' : 'Nothing here'} sub="Team chats, direct messages, event announcements and alerts will appear here. Start one with New." />
      )}
    </View>
  );

  return (
    <View style={{ gap: 10 }}>
      {split ? (
        <View style={{ flexDirection: 'row', gap: 16, alignItems: 'flex-start' }}>
          <View style={{ width: 360 }}>{left}</View>
          <View style={{ flex: 1, minWidth: 0 }}>
            {sel ? <ConversationView key={sel} id={sel} embedded onChanged={list.reload} onGone={() => { setSel(null); list.reload(); }} />
              : <Panel><Quiet title="Choose a conversation" sub="Open one from the list, or start a new message." /></Panel>}
          </View>
        </View>
      ) : left}
      {compact ? <Btn small title="Open inbox" color={c.paper} ink={c.ink} onPress={() => nav.push('Notifications')} style={{ alignSelf: 'flex-start' }} /> : null}
      {compose ? <ComposeSheet onClose={() => setCompose(false)} onStarted={(cid) => { setCompose(false); list.reload(); if (split) setSel(cid); else nav.push('Conversation', { id: cid }); }} /> : null}
    </View>
  );
}

// ------------------------------------------------------------------------------------------------------------------ a conversation
function Attachment({ a }) {
  const { toast } = useSession();
  if (a.kind === 'image') return <ProtectedImage media={a} />;
  return <Btn small color={c.paper} ink={c.ink} title={`📎 ${a.name}`} accessibilityLabel={`Open file ${a.name}`} onPress={() => openPdf(a.url.replace('/api/v1', ''), a.name).catch((e) => toast(e.message))} />;
}

function Bubble({ m, you, onPress, onAck }) {
  const mine = m.mine;
  const fg = mine && !m.hidden ? c.onAccent : c.ink, sub = mine && !m.hidden ? `${c.onAccent}CC` : c.mute;
  return (
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start' }}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${m.sender.display_name}, ${m.hidden ? 'hidden message' : m.body || 'attachment'}. Options`}
        style={{ maxWidth: '86%', minHeight: 44, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 18, borderBottomRightRadius: mine ? 6 : 18, borderBottomLeftRadius: mine ? 18 : 6, gap: 4,
          backgroundColor: m.hidden ? tint(c.violet, '10') : mine ? c.pink : tint(c.violet, '1A'), borderWidth: m.notice ? 1.5 : 0, borderColor: c.sun }}>
        {!mine ? <T size={12} weight="700" color={c.pink}>{m.sender.display_name}</T> : null}
        {m.kind === 'announcement' ? <T size={11} weight="800" color={m.notice ? (mine ? fg : c.sun) : sub} style={{ letterSpacing: 0.8 }}>{m.notice ? 'URGENT NOTICE' : 'ANNOUNCEMENT'}</T> : null}
        {m.reply_to ? <View style={{ borderLeftWidth: 3, borderLeftColor: sub, paddingLeft: 8 }}><T size={12} color={sub} numberOfLines={1}>{m.reply_to.display_name}: {m.reply_to.body ?? 'Hidden message'}</T></View> : null}
        {m.hidden ? <T size={13} color={c.mute}>This message was hidden by an organiser.</T> : m.body ? <T size={15} color={fg}>{m.body}</T> : null}
        {m.attachment ? <Attachment a={m.attachment} /> : null}
        <T size={11} color={sub}>
          {stamp(m.created_at)}
          {m.delivery ? ` · Read by ${m.delivery.read_by} of ${m.delivery.recipients}` : ''}
          {m.notice && m.notice.acknowledged !== undefined ? ` · Confirmed by ${m.notice.acknowledged}` : ''}
        </T>
      </Pressable>
      {m.notice && !m.notice.acknowledged_by_me && you.member ? <Btn small title="Confirm I've seen this" onPress={onAck} style={{ marginTop: 6 }} /> : null}
    </View>
  );
}

export function ConversationView({ id, embedded = false, onChanged, onGone }) {
  const { toast } = useSession();
  const nav = useNav();
  const conv = useLoad(() => api.get(`/conversations/${id}`), [id]);
  const [msgs, setMsgs] = useState(null);
  const [text, setText] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [announce, setAnnounce] = useState(false);
  const [mins, setMins] = useState(30);
  const [reply, setReply] = useState(null);
  const [sending, setSending] = useState(false);
  const [pick, setPick] = useState(null);       // the message whose options are open
  const [reporting, setReporting] = useState(null);
  const [info, setInfo] = useState(false);
  const [queue, setQueue] = useState(false);
  const attempt = useRef(null);
  const gone = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get(`/conversations/${id}/messages`, { limit: 100, before_seq: 1e15 });
      setMsgs(r.messages);
      if (r.messages.length) api.post(`/conversations/${id}/read`, {}).catch(() => {});
    } catch (e) {
      if (e.status === 404 && !gone.current) { gone.current = true; onGone?.(); if (!embedded) nav.back(); } else if (e.status !== 404) setMsgs((m) => m ?? []);
    }
  }, [id, embedded, nav, onGone]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 6000); return () => clearInterval(t); }, [refresh]);

  const you = conv.data?.you ?? {};
  const send = async (extra = {}) => {
    const body = text.trim();
    if (!body && !extra.attachment_id) return;
    attempt.current ??= newKey();
    setSending(true);
    try {
      await api.post(`/conversations/${id}/messages`, { body, client_id: attempt.current, reply_to_id: reply?.message_id, announcement: announce || urgent, requires_ack: urgent, escalate_after_minutes: urgent ? mins : undefined, ...extra });
      attempt.current = null; setText(''); setReply(null); setUrgent(false); setAnnounce(false);
      await refresh(); onChanged?.();
    } catch (e) { toast(e.message); } finally { setSending(false); }
  };
  const attach = async () => {
    try {
      const f = await pickDocument();
      if (!f) return;
      const kind = (f.blob.type || '').startsWith('image/') || !f.blob.type ? 'image' : 'file';
      const row = await api.upload(`/conversations/${id}/attachments`, f.blob, { kind, name: f.name || 'attachment' });
      await send({ attachment_id: row.attachment_id });
    } catch (e) { toast(/Unsupported/.test(e.message) ? 'That file type is not supported. Use a photo or a PDF.' : e.message); }
  };
  const ack = async (m) => { try { await api.post(`/conversations/${id}/messages/${m.message_id}/acknowledge`, {}); refresh(); onChanged?.(); } catch (e) { toast(e.message); } };
  const hide = async (m) => { try { await api.post(`/conversations/${id}/messages/${m.message_id}/hide`, {}); setPick(null); refresh(); } catch (e) { toast(e.message); } };
  const report = async (reason) => {
    try { await api.post(`/conversations/${id}/messages/${reporting.message_id}/report`, { reason }); setReporting(null); toast('Reported. An organiser will review it.'); } catch (e) { toast(e.message); }
  };

  if (conv.loading && !conv.data) return <Loading />;
  if (conv.error) return <ErrorBox error={conv.error} onRetry={conv.reload} />;
  const d = conv.data;
  const body = (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T weight="800" size={19} numberOfLines={1}>{d.title}</T>
          <T size={12} color={c.mute} numberOfLines={1}>{[d.kind === 'direct' ? 'Direct message' : d.kind === 'event' ? 'Event channel' : d.kind === 'group' ? 'Group' : 'Thread', d.event_name ?? d.team_name, `${d.members.length} people`].filter(Boolean).join(' · ')}</T>
        </View>
        {you.moderator ? <Btn small title="Reports" color={c.paper} ink={c.ink} onPress={() => setQueue(true)} accessibilityLabel="Open the reports for this conversation" /> : null}
        <Btn small title="Details" color={c.paper} ink={c.ink} onPress={() => setInfo(true)} accessibilityLabel="Conversation details" />
      </View>
      {you.guardian_view ? <Note>You are reading as a guardian. You can read and report, but not post.</Note> : null}
      {d.archived ? <Note>This conversation is archived. It stays readable and searchable, and takes no new messages.</Note> : null}
      {d.guardians_can_read && !you.guardian_view ? <T size={12} color={c.mute}>Guardians of young people in this conversation can read it.</T> : null}
      <View style={{ gap: 8 }}>
        {msgs === null ? <Loading /> : msgs.length ? msgs.map((m) => <Bubble key={m.message_id} m={m} you={you} onPress={() => setPick(m)} onAck={() => ack(m)} />) : <Quiet title="No messages yet" sub="Say hello." />}
      </View>
      {you.can_post ? (
        <View style={{ gap: 8 }}>
          {reply ? <Chip label={`Replying to ${reply.sender.display_name} ✕`} active onPress={() => setReply(null)} /> : null}
          {you.moderator ? (
            <HScroll>
              <Chip label="Announcement" active={announce || urgent} onPress={() => setAnnounce(!announce)} />
              <Chip label="Needs confirmation" active={urgent} onPress={() => setUrgent(!urgent)} />
              {urgent ? [15, 30, 60].map((m) => <Chip key={m} label={`Escalate after ${m} min`} active={mins === m} onPress={() => setMins(m)} />) : null}
            </HScroll>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
            <Pressable onPress={attach} accessibilityRole="button" accessibilityLabel="Attach a photo or PDF" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: tint(c.violet, '14') }}><T size={13} weight="800" color={c.violet}>Add</T></Pressable>
            <View style={{ flex: 1 }}>
              <TextInput value={text} onChangeText={(v) => { setText(v); }} placeholder="Write a message" placeholderTextColor={c.mute} multiline maxLength={4000} accessibilityLabel="Message"
                style={{ minHeight: 44, maxHeight: 120, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 11, backgroundColor: tint(c.violet, '12'), color: c.ink, fontSize: 15 }} />
            </View>
            <Btn small title="Send" onPress={() => send()} loading={sending} disabled={!text.trim()} />
          </View>
        </View>
      ) : !you.guardian_view && !d.archived ? <T size={12} color={c.mute}>{you.silenced ? 'You cannot post right now.' : d.announcements_only ? 'Only organisers post in this channel.' : 'You cannot post here.'}</T> : null}

      <Sheet visible={!!pick} onClose={() => setPick(null)} title="Message">
        {pick ? (
          <View style={{ gap: 8 }}>
            {!pick.hidden && you.can_post ? <Btn title="Reply" color={c.paper} ink={c.ink} onPress={() => { setReply(pick); setPick(null); }} /> : null}
            {!pick.mine && !pick.hidden ? <Btn title="Report" color={c.paper} ink={c.ink} onPress={() => { setReporting(pick); setPick(null); }} /> : null}
            {(pick.mine || you.moderator) && !pick.hidden ? <Btn title="Hide message" color={c.red} onPress={() => hide(pick)} /> : null}
            {pick.delivery && (pick.mine || you.moderator) ? <Delivery id={id} m={pick} /> : null}
          </View>
        ) : null}
      </Sheet>
      <Sheet visible={!!reporting} onClose={() => setReporting(null)} title="Why are you reporting this?">
        <View style={{ gap: 8 }}>
          <T size={13} color={c.mute}>Organisers see your report and the message. The sender is not told who reported.</T>
          {REASONS.map(([k, label]) => <Btn key={k} title={label} color={c.paper} ink={c.ink} onPress={() => report(k)} />)}
        </View>
      </Sheet>
      {info ? <DetailsSheet id={id} d={d} you={you} onClose={() => setInfo(false)} onChanged={() => { conv.reload(); onChanged?.(); }} onLeft={() => { setInfo(false); onGone?.(); if (!embedded) nav.back(); }} /> : null}
      {queue ? <ReportsSheet id={id} onClose={() => setQueue(false)} onChanged={refresh} /> : null}
    </View>
  );
  return embedded ? <Panel>{body}</Panel> : body;
}

function Delivery({ id, m }) {
  const q = useLoad(() => api.get(`/conversations/${id}/messages/${m.message_id}/delivery`), [id, m.message_id]);
  if (!q.data) return null;
  const d = q.data;
  return (
    <Panel>
      <T weight="700" size={13}>Delivery</T>
      <T size={13}>{d.read_by} of {d.recipients} have read it{d.acknowledged !== undefined ? ` · ${d.acknowledged} confirmed` : ''}</T>
      <T size={12} color={c.mute}>{d.in_app} in-app{d.channels.length ? ` · ${d.channels.map((x) => `${x.channel} ${x.status} ${x.n}`).join(' · ')}` : ''}</T>
    </Panel>
  );
}

function DetailsSheet({ id, d, you, onClose, onChanged, onLeft }) {
  const { toast, user } = useSession();
  const act = async (fn) => { try { await fn(); onChanged(); } catch (e) { toast(e.message); } };
  const other = d.kind === 'direct' ? d.members.find((m) => m.id !== user?.id) : null;
  return (
    <Sheet visible onClose={onClose} title={d.title}>
      <View style={{ gap: 10 }}>
        {you.member ? <Seg options={[{ value: false, label: 'Notify me' }, { value: true, label: 'Muted' }]} value={you.muted} onChange={(v) => act(() => api.post(`/conversations/${id}/mute`, { muted: v }))} color={c.violet} /> : null}
        <T weight="700" size={13} color={c.mute}>PEOPLE</T>
        {d.members.map((m) => (
          <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 }}>
            <Avatar user={m} size={36} />
            <View style={{ flex: 1 }}><T weight="700">{m.display_name}{m.young ? ' · young person' : ''}</T><T size={12} color={c.mute}>{m.role}{m.silenced ? ' · cannot post for now' : ''}</T></View>
            {you.moderator && m.id !== user?.id && d.kind !== 'direct' ? (
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <Btn small title={m.silenced ? 'Allow' : 'Pause'} color={c.paper} ink={c.ink} onPress={() => act(() => api.post(`/conversations/${id}/members/${m.id}/silence`, { minutes: m.silenced ? null : 60 }))} accessibilityLabel={`${m.silenced ? 'Allow' : 'Pause for an hour'} ${m.display_name}`} />
                <Btn small title="Remove" color={c.paper} ink={c.red} onPress={() => act(() => api.del(`/conversations/${id}/members/${m.id}`))} accessibilityLabel={`Remove ${m.display_name}`} />
              </View>
            ) : null}
          </View>
        ))}
        {you.moderator && d.kind !== 'direct' && !d.archived ? <AddPeople id={id} d={d} onDone={onChanged} /> : null}
        {you.moderator && d.kind !== 'direct' ? (
          <View style={{ gap: 8 }}>
            <T weight="700" size={13} color={c.mute}>KEEP FOR</T>
            <Seg options={[[90, '3 months'], [365, '1 year'], [730, '2 years'], [1825, '5 years']].map(([value, label]) => ({ value, label }))} value={d.retention_days} onChange={(v) => act(() => api.patch(`/conversations/${id}`, { retention_days: v }))} color={c.violet} />
            <Seg options={[{ value: false, label: 'Everyone posts' }, { value: true, label: 'Organisers only' }]} value={d.announcements_only} onChange={(v) => act(() => api.patch(`/conversations/${id}`, { announcements_only: v }))} color={c.violet} />
          </View>
        ) : null}
        {(you.moderator || d.kind === 'direct') && you.member ? <Btn title={d.archived ? 'Reopen conversation' : 'Archive conversation'} color={c.paper} ink={c.ink} onPress={() => act(() => api.patch(`/conversations/${id}`, { archived: !d.archived }))} /> : null}
        {other ? <Btn title={`Block ${other.display_name}`} color={c.paper} ink={c.red} onPress={() => act(async () => { await api.post('/me/contact-blocks', { user_id: other.id, blocked: true }); toast('Blocked. They can no longer message you.'); })} /> : null}
        {you.member ? <Btn title="Leave conversation" color={c.paper} ink={c.red} onPress={async () => { try { await api.del(`/conversations/${id}/members/${user.id}`); onLeft(); } catch (e) { toast(e.message); } }} /> : null}
      </View>
    </Sheet>
  );
}

function AddPeople({ id, d, onDone }) {
  const { toast } = useSession();
  const ctx = d.event_id ? { event_id: d.event_id } : d.team_id ? { team_id: d.team_id } : null;
  const people = useLoad(() => (ctx ? api.get('/inbox/contacts', { ...ctx, limit: 100 }) : Promise.resolve({ people: [] })), [id]);
  const [sel, setSel] = useState([]);
  if (!ctx) return null;
  const inside = new Set(d.members.map((m) => m.id));
  const add = async () => { try { await api.post(`/conversations/${id}/members`, { user_ids: sel.map((x) => x.id) }); setSel([]); onDone(); } catch (e) { toast(e.message); } };
  return (
    <View style={{ gap: 8 }}>
      <EntityPicker label="Add people" multi value={sel} onChange={setSel} options={(people.data?.people ?? []).filter((p) => !inside.has(p.id))} noun="person" />
      {sel.length ? <Btn small title={`Add ${sel.length}`} onPress={add} /> : null}
    </View>
  );
}

function ReportsSheet({ id, onClose, onChanged }) {
  const { toast } = useSession();
  const q = useLoad(() => api.get('/moderation/reports', { status: 'open', conversation_id: id }), [id]);
  const resolve = async (r, outcome, silence_minutes) => {
    try { await api.post(`/moderation/reports/${r.report_id}/resolve`, { outcome, silence_minutes }); q.reload(); onChanged(); } catch (e) { toast(e.message); }
  };
  return (
    <Sheet visible onClose={onClose} title="Reports">
      {q.loading && !q.data ? <Loading /> : q.data?.reports.length ? q.data.reports.map((r) => (
        <Panel key={r.report_id}>
          <T weight="700">{REASONS.find(([k]) => k === r.reason)?.[1] ?? r.reason}</T>
          <T size={14} style={{ marginTop: 4 }}>{r.message.sender}: {r.message.body}</T>
          {r.note ? <T size={12} color={c.mute}>Note: {r.note}</T> : null}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <Btn small title="Hide message" color={c.paper} ink={c.ink} onPress={() => resolve(r, 'hidden')} />
            <Btn small title="Hide and pause sender" color={c.paper} ink={c.ink} onPress={() => resolve(r, 'silenced', 1440)} />
            <Btn small title="Dismiss" onPress={() => resolve(r, 'dismissed')} />
          </View>
        </Panel>
      )) : <Quiet title="No open reports" sub="Reports on this conversation appear here." />}
    </Sheet>
  );
}

/** The phone screen for one conversation. */
export function Conversation({ id }) {
  return <Screen><ConversationView id={id} /></Screen>;
}

// ------------------------------------------------------------------------------------------------------------------ start something new
function ComposeSheet({ onClose, onStarted }) {
  const { toast } = useSession();
  const [kind, setKind] = useState('direct');
  const [to, setTo] = useState([]);
  const [title, setTitle] = useState('');
  const [about, setAbout] = useState(null);       // { type: 'team'|'event'|'entry', id, label }
  const [members, setMembers] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const contacts = useLoad(() => api.get('/inbox/contacts', { limit: 100 }), []);
  const ctx = useLoad(() => api.get('/inbox/contexts'), []);
  const scoped = useLoad(() => (about && about.type !== 'entry' ? api.get('/inbox/contacts', { [`${about.type}_id`]: about.id, limit: 100 }) : Promise.resolve({ people: [] })), [about?.type, about?.id]);
  const pickAbout = (type, id, label) => { setAbout({ type, id, label }); setMembers([]); };
  const chips = useMemo(() => [
    ...(ctx.data?.teams ?? []).map((t) => ({ type: 'team', id: t.team_id, label: `${t.emoji ?? ''} ${t.name}`.trim() })),
    ...(ctx.data?.events ?? []).map((e) => ({ type: 'event', id: e.event_id, label: `📅 ${e.name}`, has_channel: e.has_channel })),
    ...(kind === 'context' ? (ctx.data?.registrations ?? []).map((r) => ({ type: 'entry', id: r.entry_id, label: `📝 ${r.event_name} · ${r.entrant}` })) : []),
  ].filter((x) => (kind === 'event' ? x.type === 'event' && !x.has_channel : kind === 'group' ? x.type !== 'entry' : true)), [ctx.data, kind]);
  const ready = kind === 'direct' ? to.length === 1 : kind === 'group' ? !!about && title.trim() && members.length : kind === 'event' ? !!about : !!about;

  const start = async () => {
    setBusy(true);
    try {
      const base = { body: text.trim() || undefined };
      const link = about ? (about.type === 'entry' ? { entry_id: about.id } : { [`${about.type}_id`]: about.id }) : {};
      const body = kind === 'direct' ? { kind, user_id: to[0].id, ...base }
        : kind === 'group' ? { kind, title: title.trim(), member_ids: members.map((m) => m.id), ...link, ...base }
        : kind === 'event' ? { kind, event_id: about.id, ...base }
        : { kind, title: title.trim() || undefined, member_ids: members.map((m) => m.id), ...link, ...base };
      const r = await api.post('/conversations', body);
      onStarted(r.conversation_id);
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet visible onClose={onClose} title="New message" footer={<Btn title="Start" onPress={start} loading={busy} disabled={!ready} />}>
      <View style={{ gap: 12 }}>
        <Seg options={[['direct', 'Direct'], ['group', 'Group'], ['event', 'Event channel'], ['context', 'Thread']].map(([value, label]) => ({ value, label }))} value={kind} onChange={(v) => { setKind(v); setAbout(null); setMembers([]); }} color={c.violet} />
        {kind === 'direct' ? (
          <EntityPicker label="To" value={to} onChange={setTo} options={contacts.data?.people ?? []} noun="person" />
        ) : (
          <View style={{ gap: 8 }}>
            <T weight="700" size={12} color={c.mute}>{kind === 'context' ? 'ABOUT' : kind === 'event' ? 'EVENT' : 'FOR'}</T>
            {ctx.loading ? <Loading /> : chips.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{chips.map((x) => <Chip key={`${x.type}${x.id}`} label={x.label} active={about?.id === x.id} onPress={() => pickAbout(x.type, x.id, x.label)} />)}</View>
              : <T size={13} color={c.mute}>{kind === 'event' ? 'Every event you organise already has a channel, or you organise none yet.' : 'You do not run a team or event yet. Create one to message its people.'}</T>}
            {kind !== 'direct' && kind !== 'event' && about && about.type !== 'entry' ? <EntityPicker label="People" multi value={members} onChange={setMembers} options={scoped.data?.people ?? []} noun="person" /> : null}
            {kind === 'event' ? <T size={12} color={c.mute}>Everyone connected to the event joins: organisers, crew, players and the people of entered teams.</T> : null}
          </View>
        )}
        {kind === 'group' || kind === 'context' ? <Field label={kind === 'group' ? 'Group name' : 'Thread title (optional)'} value={title} onChangeText={setTitle} maxLength={80} /> : null}
        <Field label="First message (optional)" value={text} onChangeText={setText} multiline maxLength={4000} minHeight={80} />
        <T size={12} color={c.mute}>You can only message people you already share a team, organisation, event or family link with. If a young person is involved, their guardian can read the conversation.</T>
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------------------------------------------------------ quiet hours and escalation
/** Quiet hours and urgent-notice escalation, shown with the other notification preferences. */
export function QuietHoursCard({ prefs, onChange }) {
  const set = (patch) => onChange(patch);
  const on = !!prefs.quiet_start && !!prefs.quiet_end;
  return (
    <Panel>
      <View style={{ gap: 12 }}>
        <T weight="700">Quiet hours</T>
        <T size={13} color={c.mute}>No push, WhatsApp or SMS during these hours. Everything still waits in your inbox.</T>
        <Seg options={[{ value: false, label: 'Off' }, { value: true, label: 'On' }]} value={on} onChange={(v) => (v ? set({ quiet_start: '22:00', quiet_end: '07:00' }) : set({ quiet_start: null, quiet_end: null }))} color={c.pink} />
        {on ? (
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><TimeField label="From" value={prefs.quiet_start} onChange={(v) => set({ quiet_start: v, quiet_end: prefs.quiet_end })} step={30} /></View>
              <View style={{ flex: 1 }}><TimeField label="Until" value={prefs.quiet_end} onChange={(v) => set({ quiet_end: v, quiet_start: prefs.quiet_start })} step={30} /></View>
            </View>
            <Seg options={[{ value: false, label: 'Every day' }, { value: true, label: 'Weekdays only' }]} value={!!prefs.quiet_weekdays_only} onChange={(v) => set({ quiet_weekdays_only: v })} color={c.violet} />
            <T size={13} weight="600">Urgent notices break through quiet hours</T>
            <Seg options={[{ value: true, label: 'Yes' }, { value: false, label: 'No' }]} value={prefs.quiet_urgent_override !== false} onChange={(v) => set({ quiet_urgent_override: v })} color={c.violet} />
          </View>
        ) : null}
        <T weight="700" style={{ marginTop: 6 }}>If I don't confirm an urgent notice</T>
        <T size={13} color={c.mute}>We send it again as an urgent alert, including WhatsApp or SMS if you set those up. A young person's guardian is always told.</T>
        <HScroll>
          {[15, 30, 60].map((m) => <Chip key={m} label={`After ${m} min`} active={!prefs.escalation_off && (prefs.escalate_after_minutes ?? 30) === m} onPress={() => set({ escalation_off: false, escalate_after_minutes: m })} />)}
          <Chip label="Never" active={!!prefs.escalation_off} onPress={() => set({ escalation_off: true })} />
        </HScroll>
      </View>
    </Panel>
  );
}
