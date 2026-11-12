// R20: Crew Communication Center — main Comms screen.
// Three tabs: Threads (private crew threads), Briefings (pre-match, with ack), Docs (shared rules/permits).
// Lives inside the Officials Crew Hub as the 'comms' tab; navigates into CrewThread for the chat detail.
import React, { useState } from 'react';
import { View, ScrollView, TouchableOpacity } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, Field, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { LoadError } from '../access';
import { c, r } from '../theme';
import { t } from '../i18n';

// ── Thread type display helpers ───────────────────────────────────────────────

const TYPE_ICON = {
  general: '💬',
  briefing: '📋',
  emergency: '🚨',
  handover: '🔁',
  roster_change: '👥',
};

const TYPE_LABEL_KEY = {
  general: 'crew.comms.type_general',
  briefing: 'crew.comms.type_briefing',
  emergency: 'crew.comms.type_emergency',
  handover: 'crew.comms.type_handover',
  roster_change: 'crew.comms.type_roster_change',
};

const DOC_ICON = { rules: '📐', permit: '🪪', form: '📝', manual: '📖', other: '📎' };

const priorityColor = (th) => {
  if (th.type === 'emergency') return c.redSoft;
  if (th.type === 'handover') return c.sunSoft;
  if (th.type === 'roster_change') return c.violetSoft;
  return c.paper;
};

// ── Thread card ───────────────────────────────────────────────────────────────

const ThreadCard = ({ thread, onPress }) => {
  const hasUnread = thread.unread_count > 0;
  return (
    <TouchableOpacity
      activeOpacity={0.75}
      onPress={() => onPress(thread)}
      accessibilityLabel={`${TYPE_ICON[thread.type] ?? '💬'} ${thread.title}${hasUnread ? `, ${thread.unread_count} unread` : ''}`}
    >
      <Card style={{ marginBottom: 8, backgroundColor: priorityColor(thread), borderLeftWidth: 3, borderLeftColor: thread.type === 'emergency' ? c.red : c.line }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <T size={22}>{TYPE_ICON[thread.type] ?? '💬'}</T>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <T size={14} weight="600" style={{ flex: 1 }}>{thread.title}</T>
              {hasUnread && (
                <View style={{ backgroundColor: c.pink, borderRadius: r.pill, paddingHorizontal: 7, paddingVertical: 2 }}>
                  <T size={11} weight="700" color="#fff">{thread.unread_count}</T>
                </View>
              )}
            </View>
            <T size={12} color={c.mute} style={{ marginTop: 2 }}>
              {t(TYPE_LABEL_KEY[thread.type] ?? 'crew.comms.type_general')} · {thread.participant_count} {t('crew.comms.participants')}
            </T>
            {thread.last_msg_sender && (
              <T size={12} color={c.mute} numberOfLines={1} style={{ marginTop: 2 }}>
                {thread.last_msg_sender}: {thread.last_msg_at ? new Date(thread.last_msg_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
              </T>
            )}
          </View>
        </View>
      </Card>
    </TouchableOpacity>
  );
};

// ── Briefing card ─────────────────────────────────────────────────────────────

const BriefingCard = ({ briefing, onAck }) => (
  <Card style={{ marginBottom: 8 }} accessibilityLabel={`Briefing: ${briefing.title}`}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
      <T size={22}>📋</T>
      <View style={{ flex: 1 }}>
        <T size={14} weight="600">{briefing.title}</T>
        <T size={12} color={c.mute} style={{ marginTop: 2 }}>
          {briefing.sent_by_name} · {briefing.ack_count} {t('crew.comms.briefing_acks')}
          {briefing.requires_ack ? ` · ${t('crew.comms.ack_required')}` : ''}
        </T>
        {briefing.sport_context ? <T size={12} color={c.mute}>{briefing.sport_context}</T> : null}
        <T size={13} color={c.ink} style={{ marginTop: 8, lineHeight: 18 }} numberOfLines={4}>{briefing.body}</T>
      </View>
    </View>
    {briefing.requires_ack && !briefing.caller_acked && (
      <Btn label={t('crew.comms.btn_ack_briefing')} color={c.mintSoft} icon="✅" onPress={() => onAck(briefing)} style={{ marginTop: 10 }} />
    )}
    {briefing.caller_acked && (
      <Chip label={`✅ ${t('crew.comms.acked')}`} color={c.mintSoft} style={{ marginTop: 8, alignSelf: 'flex-start' }} />
    )}
  </Card>
);

// ── Doc card ──────────────────────────────────────────────────────────────────

const DocCard = ({ doc }) => (
  <Card style={{ marginBottom: 8 }} accessibilityLabel={`Document: ${doc.name}`}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <T size={22}>{DOC_ICON[doc.doc_category] ?? '📎'}</T>
      <View style={{ flex: 1 }}>
        <T size={14} weight="600">{doc.name}</T>
        <T size={12} color={c.mute}>{doc.doc_category} · {doc.shared_by_name}</T>
        {doc.description ? <T size={12} color={c.mute} numberOfLines={2}>{doc.description}</T> : null}
      </View>
      <Chip label={doc.mime_type.split('/')[1]?.toUpperCase().slice(0, 6) ?? doc.mime_type} color={c.cyanSoft} />
    </View>
  </Card>
);

// ── Main screen ───────────────────────────────────────────────────────────────

export const OfficialCrewComms = ({ route }) => {
  const { fixtureId, eventId } = route.params;
  const { user } = useSession();
  const nav = useNav();
  const { isTablet } = useLayout();
  const [tab, setTab] = useState('threads');
  const [newThreadSheet, setNewThreadSheet] = useState(false);
  const [newBriefingSheet, setNewBriefingSheet] = useState(false);
  const [shareDocSheet, setShareDocSheet] = useState(false);
  const [working, setWorking] = useState(false);

  // Thread form
  const [threadType, setThreadType] = useState('general');
  const [threadTitle, setThreadTitle] = useState('');

  // Briefing form
  const [briefingTitle, setBriefingTitle] = useState('');
  const [briefingBody, setBriefingBody] = useState('');
  const [briefingRequiresAck, setBriefingRequiresAck] = useState(true);

  // Doc form
  const [docName, setDocName] = useState('');
  const [docCategory, setDocCategory] = useState('rules');
  const [docUrl, setDocUrl] = useState('');
  const [docMime, setDocMime] = useState('application/pdf');

  const threadsState = useLoad(() => api.get(`/fixtures/${fixtureId}/crew-threads`), [fixtureId]);
  const briefingsState = useLoad(() => api.get(`/fixtures/${fixtureId}/crew-briefings`), [fixtureId]);
  const docsState = useLoad(() => api.get(`/fixtures/${fixtureId}/crew-docs`), [fixtureId]);

  if (threadsState.loading && tab === 'threads') return <Loading />;
  if (briefingsState.loading && tab === 'briefings') return <Loading />;
  if (docsState.loading && tab === 'docs') return <Loading />;
  if (threadsState.error) return <LoadError onRetry={threadsState.reload} />;

  const threads = threadsState.data ?? [];
  const briefings = briefingsState.data ?? [];
  const docs = docsState.data ?? [];

  const handleOpenThread = (th) => nav.push('CrewThread', { threadId: th.id, fixtureId, title: th.title });

  const handleCreateThread = async () => {
    if (!threadTitle.trim()) return;
    setWorking(true);
    try {
      const th = await api.post(`/fixtures/${fixtureId}/crew-threads`, { type: threadType, title: threadTitle });
      setNewThreadSheet(false);
      setThreadTitle('');
      threadsState.reload();
      nav.push('CrewThread', { threadId: th.id, fixtureId, title: th.title });
    } finally { setWorking(false); }
  };

  const handleAckBriefing = async (brief) => {
    setWorking(true);
    try {
      await api.post(`/crew-briefings/${brief.id}/ack`, {});
      briefingsState.reload();
    } finally { setWorking(false); }
  };

  const handleCreateBriefing = async () => {
    if (!briefingTitle.trim() || !briefingBody.trim()) return;
    setWorking(true);
    try {
      await api.post(`/fixtures/${fixtureId}/crew-briefings`, {
        title: briefingTitle, body: briefingBody, requires_ack: briefingRequiresAck,
      });
      setNewBriefingSheet(false);
      setBriefingTitle(''); setBriefingBody('');
      briefingsState.reload();
    } finally { setWorking(false); }
  };

  const handleShareDoc = async () => {
    if (!docName.trim() || !docUrl.trim()) return;
    setWorking(true);
    try {
      await api.post(`/fixtures/${fixtureId}/crew-docs`, {
        name: docName, doc_category: docCategory, url: docUrl, mime_type: docMime,
      });
      setShareDocSheet(false);
      setDocName(''); setDocUrl('');
      docsState.reload();
    } finally { setWorking(false); }
  };

  const threadsList = (
    <Section>
      {threads.length === 0
        ? <Empty icon="💬" title={t('crew.comms.no_threads_title')} body={t('crew.comms.no_threads_body')} />
        : threads.map((th) => <ThreadCard key={th.id} thread={th} onPress={handleOpenThread} />)
      }
      <Btn
        label={t('crew.comms.btn_new_thread')}
        color={c.pinkSoft}
        icon="➕"
        onPress={() => setNewThreadSheet(true)}
        style={{ marginTop: 8 }}
      />
    </Section>
  );

  const briefingsList = (
    <Section>
      {briefings.length === 0
        ? <Empty icon="📋" title={t('crew.comms.no_briefings_title')} body={t('crew.comms.no_briefings_body')} />
        : briefings.map((b) => <BriefingCard key={b.id} briefing={b} onAck={handleAckBriefing} />)
      }
      <Btn
        label={t('crew.comms.btn_new_briefing')}
        color={c.sunSoft}
        icon="📋"
        onPress={() => setNewBriefingSheet(true)}
        style={{ marginTop: 8 }}
      />
    </Section>
  );

  const docsList = (
    <Section>
      {docs.length === 0
        ? <Empty icon="📄" title={t('crew.comms.no_docs_title')} body={t('crew.comms.no_docs_body')} />
        : docs.map((d) => <DocCard key={d.id} doc={d} />)
      }
      <Btn
        label={t('crew.comms.btn_share_doc')}
        color={c.cyanSoft}
        icon="📎"
        onPress={() => setShareDocSheet(true)}
        style={{ marginTop: 8 }}
      />
    </Section>
  );

  const content = tab === 'threads' ? threadsList
    : tab === 'briefings' ? briefingsList
    : docsList;

  return (
    <Screen title={t('nav.title.OfficialCrewComms')} accessibilityLabel={t('nav.title.OfficialCrewComms')}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Seg
          options={[
            { value: 'threads', label: t('crew.comms.tab_threads') },
            { value: 'briefings', label: t('crew.comms.tab_briefings') },
            { value: 'docs', label: t('crew.comms.tab_docs') },
          ]}
          value={tab}
          onChange={setTab}
          style={{ marginBottom: 16 }}
        />
        {content}
      </ScrollView>

      {/* New Thread Sheet */}
      {newThreadSheet && (
        <FormSheet title={t('crew.comms.new_thread_title')} onClose={() => setNewThreadSheet(false)}>
          <T size={13} color={c.mute} style={{ marginBottom: 12 }}>{t('crew.comms.new_thread_body')}</T>
          <T size={13} weight="600" style={{ marginBottom: 6 }}>{t('crew.comms.thread_type_label')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
            {['general', 'briefing', 'emergency', 'handover', 'roster_change'].map((tp) => (
              <TouchableOpacity
                key={tp}
                onPress={() => setThreadType(tp)}
                accessibilityLabel={t(TYPE_LABEL_KEY[tp])}
                style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: r.pill, backgroundColor: threadType === tp ? c.pink : c.violetSoft }}
              >
                <T size={13} color={threadType === tp ? '#fff' : c.ink}>{TYPE_ICON[tp]} {t(TYPE_LABEL_KEY[tp])}</T>
              </TouchableOpacity>
            ))}
          </View>
          <Field label={t('crew.comms.thread_title_label')} value={threadTitle} onChangeText={setThreadTitle} placeholder={t('crew.comms.thread_title_placeholder')} />
          <Btn label={t('crew.comms.btn_create_thread')} color={c.pink} loading={working} onPress={handleCreateThread} style={{ marginTop: 14 }} />
        </FormSheet>
      )}

      {/* New Briefing Sheet */}
      {newBriefingSheet && (
        <FormSheet title={t('crew.comms.new_briefing_title')} onClose={() => setNewBriefingSheet(false)}>
          <Field label={t('crew.comms.briefing_title_label')} value={briefingTitle} onChangeText={setBriefingTitle} placeholder={t('crew.comms.briefing_title_placeholder')} />
          <Field label={t('crew.comms.briefing_body_label')} value={briefingBody} onChangeText={setBriefingBody} multiline placeholder={t('crew.comms.briefing_body_placeholder')} style={{ minHeight: 100 }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <TouchableOpacity
              onPress={() => setBriefingRequiresAck(!briefingRequiresAck)}
              accessibilityLabel={t('crew.comms.requires_ack_label')}
              style={{ width: 22, height: 22, borderRadius: 4, backgroundColor: briefingRequiresAck ? c.pink : c.line, alignItems: 'center', justifyContent: 'center' }}
            >
              {briefingRequiresAck ? <T size={14} color="#fff">✓</T> : null}
            </TouchableOpacity>
            <T size={13}>{t('crew.comms.requires_ack_label')}</T>
          </View>
          <Btn label={t('crew.comms.btn_send_briefing')} color={c.sun} loading={working} onPress={handleCreateBriefing} style={{ marginTop: 14 }} />
        </FormSheet>
      )}

      {/* Share Doc Sheet */}
      {shareDocSheet && (
        <FormSheet title={t('crew.comms.share_doc_title')} onClose={() => setShareDocSheet(false)}>
          <T size={13} weight="600" style={{ marginBottom: 6 }}>{t('crew.comms.doc_category_label')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
            {['rules', 'permit', 'form', 'manual', 'other'].map((cat) => (
              <TouchableOpacity
                key={cat}
                onPress={() => setDocCategory(cat)}
                accessibilityLabel={cat}
                style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: r.pill, backgroundColor: docCategory === cat ? c.cyan : c.cyanSoft }}
              >
                <T size={13} color={docCategory === cat ? '#fff' : c.ink}>{DOC_ICON[cat]} {cat}</T>
              </TouchableOpacity>
            ))}
          </View>
          <Field label={t('crew.comms.doc_name_label')} value={docName} onChangeText={setDocName} placeholder={t('crew.comms.doc_name_placeholder')} />
          <Field label={t('crew.comms.doc_url_label')} value={docUrl} onChangeText={setDocUrl} placeholder="https://…" autoCapitalize="none" />
          <Btn label={t('crew.comms.btn_upload_doc')} color={c.cyan} loading={working} onPress={handleShareDoc} style={{ marginTop: 14 }} />
        </FormSheet>
      )}
    </Screen>
  );
};
