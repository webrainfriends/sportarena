// Encrypted clinical messaging (#210).
// Threads list → message view with send. All content encrypted server-side.
// IMPORTANT: This channel is not monitored continuously — not for emergencies.
import React, { useState, useRef, useEffect } from 'react';
import { View, ScrollView, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Loading, T, Tag } from '../ui';
import { c, day } from '../theme';
import { t } from '../i18n';

function ThreadRow({ thread, onPress }) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={thread.other_party_name ?? thread.other_party_id?.slice(0, 8)}
      onPress={onPress}
      style={{ padding: 12, borderRadius: 10, backgroundColor: c.paper, gap: 4 }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <T weight="700">{thread.other_party_name ?? thread.other_party_id?.slice(0, 8) ?? '—'}</T>
        {thread.unread_count > 0 && (
          <View style={{ backgroundColor: c.violet, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 }}>
            <T size={12} color={c.white} weight="700">{thread.unread_count}</T>
          </View>
        )}
      </View>
      <T size={12} color={c.mute} numberOfLines={1}>{thread.last_message_preview ?? '—'}</T>
      {thread.last_message_at && <T size={11} color={c.mute}>{day(thread.last_message_at)}</T>}
    </TouchableOpacity>
  );
}

function MessageView({ threadId, onBack }) {
  const { toast } = useSession();
  const { user } = useSession();
  const messages = useLoad(() => api.get(`/clinical/messages?thread_id=${threadId}`), [threadId]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  const send = async () => {
    if (!body.trim()) return;
    setSending(true);
    try {
      await api.post('/clinical/messages', { thread_id: threadId, body, recipient_id: threadId });
      setBody('');
      messages.reload();
    } catch (e) {
      toast(e.message ?? t('error.generic'));
    } finally {
      setSending(false);
    }
  };

  const rows = (messages.data ?? []).slice().reverse();

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <View style={{ flex: 1, gap: 0 }}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
          onPress={onBack}
          style={{ padding: 12, height: 44, justifyContent: 'center' }}
        >
          <T color={c.violet}>← {t('common.back')}</T>
        </TouchableOpacity>

        <Card pad={10} color={c.orangeSoft} style={{ marginHorizontal: 12 }}>
          <T size={12} color={c.orange} weight="600">{t('physio.messages.disclaimer')}</T>
        </Card>

        <ScrollView
          ref={scrollRef}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          contentContainerStyle={{ gap: 8, padding: 12 }}
          style={{ flex: 1 }}
        >
          {messages.loading && !messages.data ? <Loading /> :
           messages.error ? <ErrorBox error={messages.error} onRetry={messages.reload} /> :
           rows.length === 0 ? <Empty emoji="💬" title={t('physio.messages.empty')} sub="" /> :
           rows.map((m) => {
             const mine = m.sender_id === user?.id;
             return (
               <View key={m.id} style={{ alignItems: mine ? 'flex-end' : 'flex-start' }}>
                 <View style={{
                   maxWidth: '80%', padding: 10, borderRadius: 12,
                   backgroundColor: mine ? c.violet : c.paper,
                 }}>
                   <T size={14} color={mine ? c.white : c.ink}>{m.body}</T>
                   <T size={10} color={mine ? 'rgba(255,255,255,0.7)' : c.mute} style={{ marginTop: 2 }}>{day(m.created_at)}</T>
                 </View>
               </View>
             );
           })}
        </ScrollView>

        <View style={{ flexDirection: 'row', gap: 8, padding: 12, alignItems: 'flex-end' }}>
          <TextInput
            accessibilityLabel={t('physio.messages.placeholder')}
            value={body}
            onChangeText={setBody}
            placeholder={t('physio.messages.placeholder')}
            placeholderTextColor={c.mute}
            multiline
            style={{
              flex: 1, minHeight: 44, maxHeight: 120, padding: 10,
              borderRadius: 10, backgroundColor: c.line, color: c.ink,
            }}
          />
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t('physio.messages.send')}
            onPress={send}
            disabled={sending || !body.trim()}
            style={{
              width: 44, height: 44, borderRadius: 22,
              backgroundColor: body.trim() ? c.violet : c.line,
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            <T size={20} color={body.trim() ? c.white : c.mute}>↑</T>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

export function PhysioMessages() {
  const [activeThread, setActiveThread] = useState(null);
  const threads = useLoad(() => api.get('/clinical/threads'), []);

  if (activeThread) {
    return <MessageView threadId={activeThread} onBack={() => setActiveThread(null)} />;
  }

  return (
    <ScrollView contentContainerStyle={{ gap: 12, paddingBottom: 32 }}>
      <Card pad={12} color={c.violetSoft}>
        <T weight="900" size={16}>{t('physio.messages.title')}</T>
        <T size={12} color={c.mute}>{t('physio.messages.disclaimer')}</T>
      </Card>

      {threads.loading && !threads.data ? <Loading /> :
       threads.error ? <ErrorBox error={threads.error} onRetry={threads.reload} /> :
       (threads.data ?? []).length === 0 ? <Empty emoji="💬" title={t('physio.messages.no_threads')} sub="" /> :
       (threads.data ?? []).map((th) => (
         <ThreadRow key={th.thread_id} thread={th} onPress={() => setActiveThread(th.thread_id)} />
       ))}
    </ScrollView>
  );
}

export default PhysioMessages;
