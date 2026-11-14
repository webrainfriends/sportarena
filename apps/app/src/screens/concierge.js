import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, TextInput, View, ActivityIndicator,
} from 'react-native';
import { Btn, Card, Chip, ErrorBox, Loading, Screen, T } from '../ui';
import { useLayout } from '../layout';
import { useNav } from '../nav';
import { c, dark, fam } from '../theme';
import { t } from '../i18n';
import { useApi, useApiMutation } from '../api';
import { ConciergeApproval } from './concierge-approval';

const INTENT_CHIPS = [
  { key: 'find_coach', icon: '🏅' },
  { key: 'book_court', icon: '🎾' },
  { key: 'organise_match', icon: '⚽' },
  { key: 'register_event', icon: '🏆' },
  { key: 'scout_players', icon: '🔍' },
];

function TypingIndicator() {
  return (
    <View style={[styles.bubble, styles.bubbleAssistant, styles.typingBubble]}>
      <T style={styles.typingDots}>···</T>
    </View>
  );
}

function MessageBubble({ item, onApprovalDone }) {
  const isUser = item.role === 'user';
  const isAssistant = item.role === 'assistant';
  const hasApprovals = isAssistant && item.pending_approvals?.length > 0;

  if (!item.content && !hasApprovals && !item.tool_calls) return null;

  return (
    <View style={[styles.msgRow, isUser ? styles.msgRowUser : styles.msgRowAssistant]}>
      {item.content ? (
        <View
          style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}
          accessibilityLabel={isUser ? t('concierge.a11y.message_user') : t('concierge.a11y.message_assistant')}
        >
          <T style={[styles.bubbleText, isUser ? styles.bubbleTextUser : styles.bubbleTextAssistant]}>
            {item.content}
          </T>
        </View>
      ) : null}
      {/* Pending approval cards inline */}
      {(item.pending_approvals ?? []).map((a) => (
        <ConciergeApproval key={a.id} approval={a} onDone={(r) => onApprovalDone?.(a.id, r)} />
      ))}
      <T style={[styles.msgTs, isUser ? styles.msgTsUser : {}]}>
        {item.created_at ? new Date(item.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''}
      </T>
    </View>
  );
}

export function Concierge({ route }) {
  const { session_id, fresh } = route?.params ?? {};
  const { push } = useNav();
  const { tablet } = useLayout();
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const [inputText, setInputText] = useState('');
  const [localMessages, setLocalMessages] = useState([]);
  const [pendingApprovals, setPendingApprovals] = useState({});
  const [aiTyping, setAiTyping] = useState(false);
  const [showScrollFab, setShowScrollFab] = useState(false);

  const { data: sessionData, loading, error, refetch } = useApi('get_concierge_session', { id: session_id }, { skip: !session_id });
  const { mutate: sendMessage, loading: sending, error: sendError } = useApiMutation('send_concierge_message');

  // Merge server messages with local optimistic ones
  const messages = sessionData?.messages ?? localMessages;
  const aiConfigured = sessionData?.ai_configured !== false;

  // Scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd?.({ animated: true }), 100);
    }
  }, [messages.length]);

  // Load pending approvals from session
  useEffect(() => {
    if (sessionData?.pending_approvals?.length) {
      const map = {};
      for (const a of sessionData.pending_approvals) map[a.id] = a;
      setPendingApprovals((prev) => ({ ...prev, ...map }));
    }
  }, [sessionData?.pending_approvals]);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || sending || aiTyping) return;
    setInputText('');
    setAiTyping(true);

    // Optimistic user message
    const tempId = `temp-${Date.now()}`;
    setLocalMessages((prev) => [...prev, { id: tempId, role: 'user', content: text, created_at: new Date().toISOString() }]);

    try {
      const result = await sendMessage({ id: session_id, message: text, client_key: tempId });
      if (result?.pending_approvals?.length) {
        const map = {};
        for (const a of result.pending_approvals) map[a.id] = a;
        setPendingApprovals((prev) => ({ ...prev, ...map }));
      }
      await refetch();
    } catch { /* sendError rendered below */ }
    setAiTyping(false);
  }, [inputText, sending, aiTyping, sendMessage, session_id, refetch]);

  const handleIntentChip = useCallback((chip) => {
    setInputText(t(`concierge.intent.${chip.key}`));
    inputRef.current?.focus();
  }, []);

  const handleApprovalDone = useCallback((approvalId, result) => {
    setPendingApprovals((prev) => { const next = { ...prev }; delete next[approvalId]; return next; });
    if (result?.confirmed) refetch();
  }, [refetch]);

  const session = sessionData;
  const title = session?.title ?? t('nav.title.Concierge');

  // Attach pending approvals to their assistant messages for rendering
  const enrichedMessages = messages.map((m) => {
    if (m.role !== 'assistant') return m;
    const approvals = Object.values(pendingApprovals).filter((a) => a.message_id === m.id || !a.message_id);
    return approvals.length > 0 ? { ...m, pending_approvals: approvals } : m;
  });

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <View style={[styles.inner, tablet && styles.innerTablet]}>
          {error ? <ErrorBox error={error} onRetry={refetch} /> : null}
          {loading && !sessionData ? <Loading /> : null}

          {/* Chat list */}
          <FlatList
            ref={listRef}
            data={enrichedMessages}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => <MessageBubble item={item} onApprovalDone={handleApprovalDone} />}
            contentContainerStyle={styles.listContent}
            onScroll={(e) => {
              const y = e.nativeEvent.contentOffset.y;
              const height = e.nativeEvent.layoutMeasurement.height;
              const content = e.nativeEvent.contentSize.height;
              setShowScrollFab(content - y - height > 120);
            }}
            scrollEventThrottle={200}
            ListHeaderComponent={fresh && messages.length === 0 ? (
              <View style={styles.intentChips} accessibilityRole="toolbar" accessibilityLabel={t('concierge.intent.label')}>
                <T style={styles.intentLabel}>{t('concierge.intent.label')}</T>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll}>
                  {INTENT_CHIPS.map((chip) => (
                    <Pressable
                      key={chip.key}
                      style={styles.intentChip}
                      onPress={() => handleIntentChip(chip)}
                      accessibilityRole="button"
                      accessibilityLabel={t(`concierge.intent.${chip.key}`)}
                    >
                      <T style={styles.intentChipIcon}>{chip.icon}</T>
                      <T style={styles.intentChipLabel}>{t(`concierge.intent.${chip.key}`)}</T>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            ) : null}
            ListFooterComponent={aiTyping ? <TypingIndicator /> : null}
          />

          {/* Scroll to bottom FAB */}
          {showScrollFab ? (
            <Pressable
              style={styles.scrollFab}
              onPress={() => listRef.current?.scrollToEnd?.({ animated: true })}
              accessibilityRole="button"
              accessibilityLabel={t('concierge.scrollToBottom')}
            >
              <T style={styles.scrollFabIcon}>↓</T>
            </Pressable>
          ) : null}

          {/* AI offline notice */}
          {!aiConfigured && !loading ? (
            <View style={styles.aiOffBanner}>
              <T style={styles.aiOffText}>{t('concierge.ai_off')}</T>
            </View>
          ) : null}

          {sendError ? (
            <View style={styles.sendErrorRow}>
              <T style={styles.sendErrorText}>{sendError?.message ?? t('concierge.error.generic')}</T>
            </View>
          ) : null}

          {/* Input bar */}
          <View style={styles.inputBar}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              value={inputText}
              onChangeText={setInputText}
              placeholder={t('concierge.placeholder')}
              placeholderTextColor={c.mute}
              multiline
              maxLength={2000}
              returnKeyType="default"
              accessibilityLabel={t('concierge.placeholder')}
            />
            <Pressable
              style={[styles.sendBtn, (!inputText.trim() || sending || aiTyping) && styles.sendBtnDisabled]}
              onPress={handleSend}
              disabled={!inputText.trim() || sending || aiTyping}
              accessibilityRole="button"
              accessibilityLabel={t('concierge.send')}
            >
              {sending || aiTyping
                ? <ActivityIndicator size="small" color={c.paper} />
                : <T style={styles.sendBtnText}>{t('concierge.send')}</T>
              }
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  inner: { flex: 1 },
  innerTablet: { maxWidth: 720, alignSelf: 'center', width: '100%' },
  listContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16 },
  msgRow: { marginBottom: 8, alignItems: 'flex-start' },
  msgRowUser: { alignItems: 'flex-end' },
  msgRowAssistant: { alignItems: 'flex-start', maxWidth: '86%' },
  bubble: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, maxWidth: '80%' },
  bubbleUser: { backgroundColor: dark ? c.pink : c.pinkSoft, borderBottomEndRadius: 4 },
  bubbleAssistant: { backgroundColor: c.paper, borderBottomStartRadius: 4, borderWidth: 1, borderColor: c.line },
  typingBubble: { paddingHorizontal: 18 },
  bubbleText: { fontSize: 15, lineHeight: 22 },
  bubbleTextUser: { color: dark ? c.inkOn : c.ink },
  bubbleTextAssistant: { color: c.ink },
  typingDots: { fontSize: 20, color: c.mute, letterSpacing: 4 },
  msgTs: { fontSize: 11, color: c.mute, marginTop: 2, paddingHorizontal: 4 },
  msgTsUser: { textAlign: 'right' },
  intentChips: { paddingBottom: 16 },
  intentLabel: { fontSize: 13, color: c.mute, marginBottom: 8 },
  chipScroll: { flexGrow: 0 },
  intentChip: { flexDirection: 'row', alignItems: 'center', backgroundColor: c.pinkSoft, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, marginEnd: 8, minHeight: 44, gap: 6 },
  intentChipIcon: { fontSize: 16 },
  intentChipLabel: { fontSize: 13, fontWeight: '600', color: c.ink },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.line, backgroundColor: c.paper, gap: 10 },
  input: { flex: 1, minHeight: 44, maxHeight: 120, fontSize: 15, color: c.ink, backgroundColor: c.paper, borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, fontFamily: fam?.regular, borderWidth: 1, borderColor: c.line },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnText: { color: c.paper, fontWeight: '700', fontSize: 15 },
  scrollFab: { position: 'absolute', bottom: 72, end: 16, width: 36, height: 36, borderRadius: 18, backgroundColor: c.paper, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center', elevation: 4 },
  scrollFabIcon: { fontSize: 18, color: c.ink },
  aiOffBanner: { backgroundColor: c.sunSoft, paddingHorizontal: 16, paddingVertical: 8 },
  aiOffText: { fontSize: 13, color: c.ink },
  sendErrorRow: { paddingHorizontal: 16, paddingVertical: 4 },
  sendErrorText: { fontSize: 12, color: c.pink },
});
