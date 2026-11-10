// Rule Session screen (#1021): versioned multi-turn rules Q&A, citation-grounded, offline-capable.
// API-first: all state lives on the server in rule_ai_sessions + rule_ai_turns.
// Works on phone (vertical chat), iPad (chat + history panel), desktop (3-col).
import React, { useState, useRef, useEffect } from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform, Pressable, TextInput } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, GradCard, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { LoadError } from '../access';
import { c, grad } from '../theme';
import { t } from '../i18n';

// ------------------------------------------------------------------ Pack version banner
function PackVersionBanner({ sess }) {
  if (!sess) return null;
  const label = sess.gov_pack_name ? `${sess.sport_name ?? sess.sport_slug} · ${sess.gov_pack_name} v${sess.gov_pack_version ?? '?'}` : `${sess.sport_name ?? sess.sport_slug} · ${sess.rulebook_name ?? 'Standard rules'}`;
  const effDate = sess.effective_date ?? null;
  return (
    <View style={{ backgroundColor: c.violetSoft, borderRadius: 10, padding: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <T size={13} weight="800" color={c.violet}>{label}</T>
      {effDate ? <Tag label={`Effective ${effDate}`} color={c.cyanSoft} /> : null}
      <Tag label={t('rule_ai.policy_note_short')} color={c.paper} />
    </View>
  );
}

// ------------------------------------------------------------------ Turn bubble
function CitationCard({ cit }) {
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: c.line, paddingTop: 8, gap: 3 }}>
      <T weight="800" size={13}>[{cit.n}]{cit.no ? ` §${cit.no}` : ''} {cit.title}</T>
      <T size={12.5} color={c.mute}>{cit.text}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        <T size={11.5} color={c.mute}>{cit.source}</T>
        {(cit.settings ?? []).filter((s) => s.local_change).map((s) => (
          <Tag key={s.label} label={`Local: ${s.label} = ${String(s.value)}`} color={c.sunSoft} />
        ))}
      </View>
    </View>
  );
}

function TurnBubble({ turn, sessionId, onEscalate }) {
  const [expanded, setExpanded] = useState(false);
  const declined = turn.declined;
  const insufficient = turn.insufficient;
  const isClarify = !!turn.clarifying_question && !turn.answer;
  const bg = declined ? c.redSoft : insufficient ? c.sunSoft : isClarify ? c.cyanSoft : c.paper;
  const citations = Array.isArray(turn.citations_json) ? turn.citations_json : [];
  return (
    <View style={{ gap: 6 }}>
      {/* Question */}
      <View style={{ alignSelf: 'flex-end', maxWidth: '85%', backgroundColor: c.violetSoft, borderRadius: 12, borderBottomRightRadius: 3, padding: 12 }}>
        <T size={14.5} weight="600" color={c.violet}>{turn.question}</T>
      </View>
      {/* Answer */}
      <Card color={bg} style={{ maxWidth: '90%' }}>
        <View style={{ gap: 8 }}>
          {declined ? <Tag label={t('rule_ai.declined_label')} color={c.redSoft} /> : null}
          {insufficient ? <Tag label={t('rule_ai.insufficient_label')} color={c.sunSoft} /> : null}
          {isClarify ? <Tag label={t('rule_ai.clarification_header')} color={c.cyanSoft} /> : null}
          <T size={14.5}>{turn.answer ?? turn.clarifying_question ?? turn.message}</T>
          {citations.length > 0 ? (
            <Pressable onPress={() => setExpanded((x) => !x)} accessibilityLabel="Toggle citations">
              <T size={12.5} color={c.violet} weight="700">{expanded ? '▲ Hide' : '▼ Show'} {citations.length} {t('rule_ai.citation_prefix')} citation{citations.length !== 1 ? 's' : ''}</T>
            </Pressable>
          ) : null}
          {expanded ? citations.map((cit) => <CitationCard key={cit.n} cit={cit} />) : null}
          {turn.ai_used ? <T size={11.5} color={c.mute}>{t('rule_ai.ai_note')}</T> : null}
          {!turn.escalated && !declined && !insufficient ? (
            <Pressable onPress={() => onEscalate(turn)} accessibilityLabel="Escalate this turn">
              <T size={12.5} color={c.mute}>{t('rule_ai.escalate')}</T>
            </Pressable>
          ) : null}
          {turn.escalated ? <Tag label={t('rule_ai.escalated_label')} color={c.sunSoft} /> : null}
        </View>
      </Card>
    </View>
  );
}

// ------------------------------------------------------------------ Escalate sheet
function EscalateSheet({ turn, sessionId, onDone, onClose }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const { toast } = useSession();
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api.post(`/rule-sessions/${sessionId}/turns/${turn.id}/escalate`, { reason });
      toast(t('rule_ai.escalate_success'));
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Sheet title={t('rule_ai.escalate')} onClose={onClose}>
      <View style={{ gap: 14, paddingBottom: 20 }}>
        <Card color={c.sunSoft}><T size={13}>{turn.question}</T></Card>
        <TextInput
          value={reason} onChangeText={setReason}
          placeholder={t('rule_ai.escalate_reason_placeholder')}
          multiline style={{ borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 12, minHeight: 80, fontSize: 14, color: c.ink }}
          accessibilityLabel="Escalation reason"
        />
        {err ? <T color={c.red}>{err.message}</T> : null}
        <Btn title={t('rule_ai.escalate')} onPress={submit} loading={busy} disabled={reason.trim().length < 5} />
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------------ Session history panel (tablet/desktop left column)
function SessionHistoryPanel({ fixtureId, activeId, onSelect }) {
  const q = useLoad(() => api.get(`/fixtures/${fixtureId}/rule-sessions`), [fixtureId]);
  if (!fixtureId) return null;
  const sessions = q.data?.sessions ?? [];
  return (
    <View style={{ width: 260, borderRightWidth: 1, borderRightColor: c.line, paddingRight: 12 }}>
      <T size={12} weight="800" color={c.mute} style={{ marginBottom: 8 }}>{t('rule_ai.session_history')}</T>
      {!sessions.length && !q.loading ? <T size={13} color={c.mute}>{t('rule_ai.no_sessions')}</T> : null}
      {q.loading ? <Loading /> : sessions.map((s) => (
        <Pressable key={s.id} onPress={() => onSelect(s.id)} accessibilityLabel={`Rule session ${s.id}`}>
          <Card color={s.id === activeId ? c.violetSoft : c.paper} style={{ marginBottom: 8 }}>
            <T size={13} weight={s.id === activeId ? '700' : '400'}>{s.gov_pack_name ?? s.sport_slug} · {s.turn_count} {t('rule_ai.turn_count_short')}</T>
            <T size={12} color={c.mute}>{s.created_at ? new Date(s.created_at).toLocaleDateString() : ''}</T>
            {s.status === 'closed' ? <Tag label="Closed" color={c.line} /> : null}
          </Card>
        </Pressable>
      ))}
    </View>
  );
}

// ------------------------------------------------------------------ Main screen
export function RuleSessionScreen({ sessionId: initSessionId, fixtureId, sport }) {
  const { push } = useNav();
  const L = useLayout();
  const { toast } = useSession();
  const isWide = L.width >= 768;

  const [sessionId, setSessionId] = useState(initSessionId ?? null);
  const [question, setQuestion] = useState('');
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState(null);
  const [escalateTurn, setEscalateTurn] = useState(null);
  const scrollRef = useRef(null);

  const sessQ = useLoad(() => sessionId ? api.get(`/rule-sessions/${sessionId}`) : null, [sessionId]);
  const sess = sessQ.data;

  // Start a new session if none provided
  const startSession = async () => {
    setSending(true); setSendErr(null);
    try {
      const s = await api.post(`/fixtures/${fixtureId}/rule-sessions`, {});
      setSessionId(s.session_id);
    } catch (e) { setSendErr(e); } finally { setSending(false); }
  };

  useEffect(() => {
    if (!sessionId && fixtureId) startSession();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendQuestion = async () => {
    if (!sessionId || question.trim().length < 3) return;
    setSending(true); setSendErr(null);
    try {
      await api.post(`/rule-sessions/${sessionId}/ask`, { question });
      setQuestion('');
      await sessQ.reload();
      setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 150);
    } catch (e) { setSendErr(e); } finally { setSending(false); }
  };

  const handleEscalateDone = () => { setEscalateTurn(null); sessQ.reload(); };

  const turns = sess?.turns ?? [];

  const chatPane = (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }} keyboardVerticalOffset={90}>
      <ScrollView ref={scrollRef} style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 120 }}>
        {!sessionId ? (
          <Empty emoji="📖" title={t('rule_ai.start_first')} sub={t('rule_ai.start_first_sub')}>
            <Btn title={t('rule_ai.session_start')} onPress={startSession} loading={sending} style={{ marginTop: 12 }} />
          </Empty>
        ) : sessQ.loading && !sess ? <Loading /> : (
          <>
            <PackVersionBanner sess={sess} />
            {!turns.length ? (
              <Empty emoji="💬" title={t('rule_ai.no_turns')} sub={t('rule_ai.ask_first')} />
            ) : turns.map((turn) => (
              <TurnBubble key={turn.id} turn={turn} sessionId={sessionId} onEscalate={setEscalateTurn} />
            ))}
          </>
        )}
        {sendErr ? <LoadError error={sendErr} onRetry={sendQuestion} /> : null}
      </ScrollView>
      {/* Ask bar */}
      {sessionId && sess?.status !== 'closed' ? (
        <View style={{ flexDirection: 'row', gap: 10, padding: 12, borderTopWidth: 1, borderTopColor: c.line, backgroundColor: c.bg }}>
          <TextInput
            value={question} onChangeText={setQuestion}
            placeholder={t('rule_ai.ask_placeholder')}
            style={{ flex: 1, borderWidth: 1, borderColor: c.line, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: c.ink, minHeight: 44 }}
            multiline maxLength={500}
            accessibilityLabel="Rules question input"
            returnKeyType="send" onSubmitEditing={sendQuestion} blurOnSubmit={false}
          />
          <Btn title="→" onPress={sendQuestion} loading={sending} disabled={question.trim().length < 3} style={{ minWidth: 48, minHeight: 44 }} />
        </View>
      ) : null}
      {sess?.status === 'closed' ? (
        <View style={{ padding: 12, alignItems: 'center', borderTopWidth: 1, borderTopColor: c.line }}>
          <T size={13} color={c.mute}>{t('rule_ai.session_closed')}</T>
          {fixtureId ? <Btn small title={t('rule_ai.session_start')} onPress={startSession} loading={sending} style={{ marginTop: 8 }} /> : null}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );

  return (
    <Screen>
      <GradCard colors={grad.hero}>
        <View style={{ gap: 6 }}>
          <T size={12} weight="800" color="#fff" style={{ letterSpacing: 0.6 }}>{t('rule_ai.title').toUpperCase()}</T>
          {sess ? <T size={20} weight="800" color="#fff">{sess.sport_name ?? sess.sport_slug}</T> : <T size={20} weight="800" color="#fff">{t('rule_ai.loading_session')}</T>}
          <T size={12.5} color="rgba(255,255,255,0.75)">{t('rule_ai.policy_note')}</T>
        </View>
      </GradCard>
      {isWide ? (
        <View style={{ flex: 1, flexDirection: 'row', gap: 16, padding: 16 }}>
          <SessionHistoryPanel fixtureId={fixtureId} activeId={sessionId} onSelect={setSessionId} />
          <View style={{ flex: 1 }}>{chatPane}</View>
        </View>
      ) : (
        chatPane
      )}
      {escalateTurn ? (
        <EscalateSheet turn={escalateTurn} sessionId={sessionId} onDone={handleEscalateDone} onClose={() => setEscalateTurn(null)} />
      ) : null}
    </Screen>
  );
}

// ------------------------------------------------------------------ Escalation inbox (organiser / assessor)
export function RulesEscalationInbox({ eventId }) {
  const [status, setStatus] = useState('open');
  const [resolving, setResolving] = useState(null);
  const [resNote, setResNote] = useState('');
  const [outcome, setOutcome] = useState('confirmed');
  const [busy, setBusy] = useState(false);
  const { toast } = useSession();
  const q = useLoad(() => api.get('/rule-escalations', { event_id: eventId, status }), [eventId, status]);
  const escalations = q.data?.escalations ?? [];

  const submitResolve = async () => {
    setBusy(true);
    try {
      await api.post(`/rule-escalations/${resolving.id}/resolve`, { resolution_note: resNote, outcome });
      toast(t('rule_ai.resolved_success'));
      setResolving(null); setResNote('');
      q.reload();
    } catch (e) { toast(e.message); } finally { setBusy(false); }
  };

  return (
    <View style={{ gap: 12 }}>
      <Seg
        options={[{ value: 'open', label: 'Open' }, { value: 'resolved', label: 'Resolved' }, { value: 'withdrawn', label: 'Withdrawn' }]}
        value={status} onChange={setStatus}
      />
      {q.loading ? <Loading /> : !escalations.length ? (
        <Empty emoji="✅" title={status === 'open' ? t('rule_ai.no_open_escalations') : t('rule_ai.no_escalations')} sub="" />
      ) : escalations.map((e) => (
        <Card key={e.id} color={e.status === 'open' ? c.sunSoft : c.paper}>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <Tag label={e.sport_slug} color={c.violetSoft} />
              <Tag label={e.status} color={e.status === 'open' ? c.sunSoft : c.mintSoft} />
            </View>
            <T weight="700" size={14}>Q: {e.question}</T>
            {e.answer ? <T size={13} color={c.mute}>A: {e.answer}</T> : null}
            <T size={13}>Reason: {e.reason}</T>
            <T size={12} color={c.mute}>{new Date(e.created_at).toLocaleDateString()}</T>
            {e.status === 'open' ? (
              <Btn small title={t('rule_ai.resolve')} onPress={() => { setResolving(e); setResNote(''); }} />
            ) : null}
          </View>
        </Card>
      ))}
      {resolving ? (
        <Sheet title={t('rule_ai.resolve')} onClose={() => setResolving(null)}>
          <View style={{ gap: 14, paddingBottom: 20 }}>
            <Card color={c.violetSoft}><T size={13}>{resolving.question}</T></Card>
            <Seg
              options={[{ value: 'confirmed', label: 'Confirmed' }, { value: 'amended', label: 'Amended' }, { value: 'deferred', label: 'Deferred' }]}
              value={outcome} onChange={setOutcome}
            />
            <TextInput
              value={resNote} onChangeText={setResNote}
              placeholder={t('rule_ai.resolution_placeholder')}
              multiline style={{ borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 12, minHeight: 80, fontSize: 14, color: c.ink }}
              accessibilityLabel="Resolution note"
            />
            <Btn title={t('rule_ai.resolve')} onPress={submitResolve} loading={busy} disabled={resNote.trim().length < 5} />
          </View>
        </Sheet>
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------ Rules tab for officials-home (replaces inline AskRules)
export function RulesTab({ fixtureId, sport, isOrg }) {
  const { push } = useNav();
  const q = useLoad(() => fixtureId ? api.get(`/fixtures/${fixtureId}/rule-sessions`) : null, [fixtureId]);
  const sessions = q.data?.sessions ?? [];
  const latest = sessions[0] ?? null;
  const [starting, setStarting] = useState(false);
  const { toast } = useSession();

  const startAndOpen = async () => {
    setStarting(true);
    try {
      const s = fixtureId
        ? await api.post(`/fixtures/${fixtureId}/rule-sessions`, {})
        : null;
      push('RuleSession', { sessionId: s?.session_id, fixtureId, sport });
    } catch (e) { toast(e.message); } finally { setStarting(false); }
  };

  return (
    <View style={{ gap: 12 }}>
      {fixtureId ? (
        <Card color={c.violetSoft}>
          <T size={13} color={c.mute}>{t('rule_ai.context_note')}</T>
        </Card>
      ) : null}
      {/* Quick-ask (stateless, keeps existing AskRules behaviour) */}
      {/* Session list */}
      {q.loading ? <Loading /> : sessions.length > 0 ? (
        <View style={{ gap: 8 }}>
          <T size={12} weight="800" color={c.mute}>{t('rule_ai.session_history')}</T>
          {sessions.map((s) => (
            <Card key={s.id} onPress={() => push('RuleSession', { sessionId: s.id, fixtureId, sport })}
              accessibilityLabel={`Rule session ${s.id}`}
              color={s.status === 'open' ? c.paper : c.line}>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  <T weight="700" size={14}>{s.gov_pack_name ?? s.sport_slug}</T>
                  {s.gov_pack_version ? <Tag label={`v${s.gov_pack_version}`} color={c.cyanSoft} /> : null}
                  <Tag label={s.status} color={s.status === 'open' ? c.mintSoft : c.line} />
                </View>
                <T size={13} color={c.mute}>{s.turn_count} {t('rule_ai.turn_count_short')} · {s.created_at ? new Date(s.created_at).toLocaleDateString() : ''}</T>
              </View>
            </Card>
          ))}
        </View>
      ) : (
        <Empty emoji="💬" title={t('rule_ai.no_sessions')} sub={t('rule_ai.start_first')} />
      )}
      <Btn title={t('rule_ai.session_start')} onPress={startAndOpen} loading={starting} style={{ minHeight: 48 }} />
      {isOrg ? (
        <Section title={t('rule_ai.escalation_inbox')} color={c.sun}>
          <RulesEscalationInbox eventId={null} />
        </Section>
      ) : null}
    </View>
  );
}
