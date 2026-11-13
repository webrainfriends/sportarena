// R20: Crew thread chat detail screen.
// Real-time 2-way messaging with long-poll (after_seq + wait_seconds=20).
// Supports: text, emergency, roster_change, handover message types. Reply threading. Read receipts. Flag message.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, TouchableOpacity, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Field, Loading, Screen, T } from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError } from '../access';
import { c, r } from '../theme';
import { t } from '../i18n';

const MSG_BG = {
  emergency: c.redSoft,
  roster_change: c.violetSoft,
  handover: c.sunSoft,
  system: c.cyanSoft,
  text: null,
  attachment: null,
};

const MSG_TYPE_ICON = {
  emergency: '🚨',
  roster_change: '👥',
  handover: '🔁',
  system: 'ℹ️',
  attachment: '📎',
  text: null,
};

function relativeTime(ts) {
  if (!ts) return '';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return t('crew.comms.just_now');
  if (diff < 3600) return `${Math.floor(diff / 60)}${t('crew.comms.min_ago')}`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}${t('crew.comms.hr_ago')}`;
  return new Date(ts).toLocaleDateString();
}

// ── Single message bubble ─────────────────────────────────────────────────────

const MessageBubble = ({ msg, isOwn, onReply, onFlag }) => {
  const bg = MSG_BG[msg.msg_type] ?? (isOwn ? c.pinkSoft : c.paper);
  const icon = MSG_TYPE_ICON[msg.msg_type];
  return (
    <View
      style={{ marginBottom: 10, alignItems: isOwn ? 'flex-end' : 'flex-start' }}
      accessibilityLabel={`${msg.sender_name}: ${msg.body}${msg.is_read ? '' : ', unread'}`}
    >
      {/* Reply context */}
      {msg.reply_to_id && (
        <View style={{ marginBottom: 4, paddingLeft: isOwn ? 0 : 8, paddingRight: isOwn ? 8 : 0 }}>
          <T size={11} color={c.mute}>{t('crew.comms.replying_to')}</T>
        </View>
      )}
      <View style={{ maxWidth: '80%', backgroundColor: bg, borderRadius: r.card, padding: 12,
        shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4, shadowOffset: { width: 0, height: 1 },
        elevation: 1, borderLeftWidth: msg.msg_type !== 'text' ? 3 : 0,
        borderLeftColor: msg.msg_type === 'emergency' ? c.red : msg.msg_type === 'roster_change' ? c.pink : c.sun,
      }}>
        {!isOwn && (
          <T size={12} weight="600" color={c.pink} style={{ marginBottom: 3 }}>{msg.sender_name}</T>
        )}
        {icon && <T size={13} style={{ marginBottom: 4 }}>{icon} {msg.msg_type?.replace('_', ' ')}</T>}
        <T size={14} color={c.ink} style={{ lineHeight: 20 }}>{msg.body}</T>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, alignItems: 'center' }}>
          <T size={11} color={c.mute}>{relativeTime(msg.created_at)}</T>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {msg.read_count > 0 && (
              <T size={11} color={c.mute}>✓{msg.read_count}</T>
            )}
          </View>
        </View>
      </View>
      {/* Actions */}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 3 }}>
        <TouchableOpacity onPress={() => onReply(msg)} accessibilityLabel={t('crew.comms.btn_reply')}>
          <T size={12} color={c.mute}>{t('crew.comms.btn_reply')}</T>
        </TouchableOpacity>
        {!isOwn && (
          <TouchableOpacity onPress={() => onFlag(msg)} accessibilityLabel={t('crew.comms.btn_flag')}>
            <T size={12} color={c.mute}>{t('crew.comms.btn_flag')}</T>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
};

// ── Main screen ───────────────────────────────────────────────────────────────

export const CrewThread = ({ route }) => {
  const { threadId, fixtureId, title } = route.params;
  const { user } = useSession();
  const nav = useNav();

  const [messages, setMessages] = useState([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [sending, setSending] = useState(false);
  const [body, setBody] = useState('');
  const [msgType, setMsgType] = useState('text');
  const [replyTo, setReplyTo] = useState(null);
  const [flagSheet, setFlagSheet] = useState(null);
  const [flagReason, setFlagReason] = useState('inappropriate_conduct');
  const [flagNotes, setFlagNotes] = useState('');
  const [flagging, setFlagging] = useState(false);
  const afterSeqRef = useRef(0);
  const pollingRef = useRef(true);
  const listRef = useRef(null);

  // Load initial messages
  useEffect(() => {
    (async () => {
      try {
        const msgs = await api.get(`/crew-threads/${threadId}/messages?limit=40`);
        const sorted = [...msgs].sort((a, b) => a.seq - b.seq);
        setMessages(sorted);
        if (sorted.length) afterSeqRef.current = sorted[sorted.length - 1].seq;
      } finally { setLoadingInitial(false); }
    })();
    // Mark read
    api.post(`/crew-threads/${threadId}/messages/read`, {}).catch(() => {});
    return () => { pollingRef.current = false; };
  }, [threadId]);

  // Long-poll loop
  useEffect(() => {
    pollingRef.current = true;
    const poll = async () => {
      while (pollingRef.current) {
        try {
          const newMsgs = await api.get(
            `/crew-threads/${threadId}/messages?after_seq=${afterSeqRef.current}&wait_seconds=20&limit=40`,
          );
          if (!pollingRef.current) break;
          if (newMsgs.length) {
            const sorted = [...newMsgs].sort((a, b) => a.seq - b.seq);
            setMessages((prev) => {
              const ids = new Set(prev.map((m) => m.id));
              const added = sorted.filter((m) => !ids.has(m.id));
              return added.length ? [...prev, ...added] : prev;
            });
            afterSeqRef.current = sorted[sorted.length - 1].seq;
            api.post(`/crew-threads/${threadId}/messages/read`, {}).catch(() => {});
            setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
          }
        } catch (_) {
          if (!pollingRef.current) break;
          await new Promise((res) => setTimeout(res, 3000));
        }
      }
    };
    poll();
    return () => { pollingRef.current = false; };
  }, [threadId]);

  const handleSend = async () => {
    const text = body.trim();
    if (!text) return;
    setSending(true);
    const clientId = `${user.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setBody('');
    setReplyTo(null);
    try {
      const msg = await api.post(`/crew-threads/${threadId}/messages`, {
        body: text, msg_type: msgType, reply_to_id: replyTo?.id ?? undefined, client_id: clientId,
      });
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        return ids.has(msg.id) ? prev : [...prev, msg];
      });
      if (msg.seq) afterSeqRef.current = Math.max(afterSeqRef.current, msg.seq);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    } catch (e) {
      setBody(text);
    } finally { setSending(false); }
  };

  const handleFlag = async () => {
    if (!flagSheet) return;
    setFlagging(true);
    try {
      await api.post(`/crew-messages/${flagSheet.id}/flag`, { reason: flagReason, notes: flagNotes || undefined });
      setFlagSheet(null); setFlagNotes('');
    } finally { setFlagging(false); }
  };

  if (loadingInitial) return <Loading />;

  const msgTypeOptions = ['text', 'emergency', 'roster_change', 'handover'];
  const flagReasons = ['inappropriate_conduct', 'misinformation', 'personal_data_disclosed', 'other'];

  return (
    <Screen title={title ?? t('nav.title.CrewThread')} accessibilityLabel={title ?? t('nav.title.CrewThread')}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        {/* Message list */}
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 8 }}
          onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={
            <T size={13} color={c.mute} style={{ textAlign: 'center', marginTop: 32 }}>
              {t('crew.comms.no_messages_yet')}
            </T>
          }
          renderItem={({ item }) => (
            <MessageBubble
              msg={item}
              isOwn={item.sender_id === user.id}
              onReply={(m) => setReplyTo(m)}
              onFlag={(m) => setFlagSheet(m)}
            />
          )}
        />

        {/* Reply banner */}
        {replyTo && (
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8, backgroundColor: c.violetSoft, borderTopWidth: 1, borderTopColor: c.line }}>
            <T size={12} color={c.mute} style={{ flex: 1 }}>
              ↩ {t('crew.comms.replying_to')} {replyTo.sender_name}: {replyTo.body?.slice(0, 50)}
            </T>
            <TouchableOpacity onPress={() => setReplyTo(null)} accessibilityLabel={t('common.cancel')}>
              <T size={18} color={c.mute}>✕</T>
            </TouchableOpacity>
          </View>
        )}

        {/* Message type picker */}
        <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 14, paddingTop: 6 }}>
          {msgTypeOptions.map((tp) => (
            <TouchableOpacity
              key={tp}
              onPress={() => setMsgType(tp)}
              accessibilityLabel={tp}
              style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: r.pill, backgroundColor: msgType === tp ? c.pink : c.violetSoft }}
            >
              <T size={12} color={msgType === tp ? '#fff' : c.mute}>
                {MSG_TYPE_ICON[tp] ?? ''} {tp === 'text' ? t('crew.comms.type_text') : t(`crew.comms.type_${tp}`) }
              </T>
            </TouchableOpacity>
          ))}
        </View>

        {/* Compose bar */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 8, borderTopWidth: 1, borderTopColor: c.line, backgroundColor: c.bg }}>
          <Field
            value={body}
            onChangeText={setBody}
            placeholder={t('crew.comms.compose_placeholder')}
            multiline
            returnKeyType="default"
            style={{ flex: 1, maxHeight: 120 }}
            accessibilityLabel={t('crew.comms.compose_placeholder')}
          />
          <Btn
            label={t('crew.comms.btn_send')}
            color={c.pink}
            loading={sending}
            onPress={handleSend}
            disabled={!body.trim()}
            accessibilityLabel={t('crew.comms.btn_send')}
          />
        </View>
      </KeyboardAvoidingView>

      {/* Flag sheet */}
      {flagSheet && (
        <FormSheet title={t('crew.comms.flag_sheet_title')} onClose={() => setFlagSheet(null)}>
          <T size={13} color={c.mute} style={{ marginBottom: 10 }}>{t('crew.comms.flag_sheet_body')}</T>
          <T size={13} weight="600" style={{ marginBottom: 6 }}>{t('crew.comms.flag_reason_label')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
            {flagReasons.map((fr) => (
              <TouchableOpacity
                key={fr}
                onPress={() => setFlagReason(fr)}
                accessibilityLabel={fr.replace(/_/g, ' ')}
                style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: r.pill, backgroundColor: flagReason === fr ? c.red : c.redSoft }}
              >
                <T size={12} color={flagReason === fr ? '#fff' : c.ink}>{fr.replace(/_/g, ' ')}</T>
              </TouchableOpacity>
            ))}
          </View>
          <Field label={t('crew.comms.flag_notes_label')} value={flagNotes} onChangeText={setFlagNotes} multiline placeholder={t('crew.comms.flag_notes_placeholder')} />
          <Btn label={t('crew.comms.btn_submit_flag')} color={c.red} loading={flagging} onPress={handleFlag} style={{ marginTop: 14 }} />
        </FormSheet>
      )}
    </Screen>
  );
};
