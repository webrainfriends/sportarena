// Fan & Community Feed — sport challenges screens (issue #522).
// FeedChallenges: browse, FeedChallengeDetail: detail+leaderboard, FeedChallengeCreate: org staff form, FeedChallengeEntry: evidence submission.
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, ActivityIndicator, FlatList, Switch } from 'react-native';
import { useTranslation } from '../i18n/index.js';
import { c, r } from '../theme.js';
import { api } from '../api.js';

const relativeDate = (iso) => {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

// ── Chip ─────────────────────────────────────────────────────────────────────
function Chip({ label, active, onPress }) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      onPress={onPress}
      style={{ backgroundColor: active ? c.pink : c.line, borderRadius: r.full, paddingHorizontal: 14, paddingVertical: 7, minHeight: 36, justifyContent: 'center' }}
    >
      <Text style={{ fontSize: 13, fontWeight: active ? '700' : '400', color: active ? c.paper : c.ink }}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── ChallengeCard ─────────────────────────────────────────────────────────────
function ChallengeCard({ ch, onPress }) {
  const { t } = useTranslation();
  const kinds = {
    participation_streak: t('cf.challenge_kind_participation_streak'),
    activity: t('cf.challenge_kind_activity'),
    skill: t('cf.challenge_kind_skill'),
    community: t('cf.challenge_kind_community'),
  };
  return (
    <TouchableOpacity
      accessibilityRole="button"
      onPress={() => onPress?.(ch)}
      style={{ backgroundColor: c.paper, borderRadius: r.md, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: c.line }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <View style={{ flex: 1, paddingEnd: 10 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: c.ink, marginBottom: 4 }}>{ch.title}</Text>
          <Text style={{ fontSize: 12, color: c.mute, marginBottom: 6 }}>{ch.org_name} · {ch.sport_name ?? '—'}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <View style={{ backgroundColor: c.bg, borderRadius: r.xs, paddingHorizontal: 7, paddingVertical: 3 }}>
              <Text style={{ fontSize: 11, color: c.mute }}>{kinds[ch.kind] ?? ch.kind}</Text>
            </View>
            {ch.is_sponsored && (
              <View style={{ backgroundColor: c.violet, borderRadius: r.xs, paddingHorizontal: 7, paddingVertical: 3 }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: c.paper }}>{t('cf.challenge_sponsored_badge')}</Text>
              </View>
            )}
          </View>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ fontSize: 12, color: c.pink, fontWeight: '700' }}>{String(ch.entries_count ?? 0)} entries</Text>
          <Text style={{ fontSize: 11, color: c.mute, marginTop: 2 }}>{relativeDate(ch.end_at)}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ── FeedChallenges ─────────────────────────────────────────────────────────────
export function FeedChallenges({ navigation }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState('active');
  const [challenges, setChallenges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (before = null) => {
    if (before) setLoadingMore(true); else setLoading(true);
    try {
      const qs = new URLSearchParams({ status, ...(before ? { before } : {}) }).toString();
      const rows = await api.get(`/feed/challenges?${qs}`);
      if (!before) setChallenges(rows); else setChallenges((p) => [...p, ...rows]);
      const last = rows.slice(-1)[0];
      setCursor(last ? `${last.start_at}|${last.id}` : null);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flexDirection: 'row', gap: 8, padding: 14, paddingBottom: 8 }}>
        <Chip label={t('cf.challenges_active')} active={status === 'active'} onPress={() => { setStatus('active'); setCursor(null); }} />
        <Chip label={t('cf.challenges_closed')} active={status === 'closed'} onPress={() => { setStatus('closed'); setCursor(null); }} />
      </View>
      {loading
        ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={c.pink} /></View>
        : <FlatList
            data={challenges}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ padding: 14, paddingTop: 6 }}
            renderItem={({ item }) => <ChallengeCard ch={item} onPress={(ch) => navigation?.navigate('FeedChallengeDetail', { id: ch.id })} />}
            ListEmptyComponent={<View style={{ alignItems: 'center', paddingTop: 60 }}><Text style={{ fontSize: 15, color: c.mute }}>No challenges found</Text></View>}
            onEndReached={() => { if (cursor && !loadingMore) load(cursor); }}
            onEndReachedThreshold={0.3}
            ListFooterComponent={loadingMore ? <ActivityIndicator color={c.pink} style={{ padding: 16 }} /> : null}
          />
      }
    </View>
  );
}

// ── FeedChallengeDetail ────────────────────────────────────────────────────────
export function FeedChallengeDetail({ route, navigation }) {
  const { t } = useTranslation();
  const { id } = route?.params ?? {};
  const [ch, setCh] = useState(null);
  const [leaderboard, setLeaderboard] = useState(null);
  const [tab, setTab] = useState('rules');
  const [loading, setLoading] = useState(true);
  const [entering, setEntering] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([
      api.get(`/feed/challenges/${id}`),
      api.get(`/feed/challenges/${id}/leaderboard`),
    ]).then(([chData, lb]) => {
      setCh(chData);
      setLeaderboard(lb);
    }).finally(() => setLoading(false));
  }, [id]);

  const enter = async () => {
    if (!id || entering) return;
    setEntering(true);
    try {
      await api.post(`/feed/challenges/${id}/entries`);
      setCh((prev) => prev ? { ...prev, my_entry: { status: 'entered' } } : prev);
    } finally {
      setEntering(false);
    }
  };

  if (loading || !ch) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}><ActivityIndicator color={c.pink} /></View>;

  const hasEntry = ch.my_entry && ch.my_entry.status !== 'withdrawn';
  const canEnter = ch.status === 'active' && !hasEntry;

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {/* Header */}
        <Text style={{ fontSize: 22, fontWeight: '700', color: c.ink, marginBottom: 4 }}>{ch.title}</Text>
        <Text style={{ fontSize: 14, color: c.mute, marginBottom: 10 }}>{ch.org_name} · {ch.sport_name}</Text>
        {ch.is_sponsored && ch.disclosure_text && (
          <View style={{ backgroundColor: c.violet + '22', borderRadius: r.sm, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: c.violet }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: c.violet, marginBottom: 2 }}>{t('cf.challenge_disclosure')}</Text>
            <Text style={{ fontSize: 12, color: c.ink }}>{ch.disclosure_text}</Text>
          </View>
        )}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
          <Text style={{ fontSize: 12, color: c.mute }}>
            {relativeDate(ch.start_at)} – {relativeDate(ch.end_at)}
          </Text>
          <Text style={{ fontSize: 12, color: c.mute }}>·</Text>
          <Text style={{ fontSize: 12, color: c.pink, fontWeight: '700' }}>{String(ch.entries_count ?? 0)} entries</Text>
          {ch.quota && <Text style={{ fontSize: 12, color: c.mute }}>/ {ch.quota} max</Text>}
        </View>
        {/* Tabs */}
        <View style={{ flexDirection: 'row', gap: 6, marginBottom: 16 }}>
          {['rules','leaderboard','entries'].map((key) => (
            <Chip key={key} label={t(`cf.challenge_${key}`)} active={tab === key} onPress={() => setTab(key)} />
          ))}
        </View>
        {/* Rules */}
        {tab === 'rules' && (
          <View>
            {(ch.description) && <Text style={{ fontSize: 14, color: c.ink, marginBottom: 14, lineHeight: 20 }}>{ch.description}</Text>}
            <Text style={{ fontSize: 15, fontWeight: '700', color: c.ink, marginBottom: 10 }}>{t('cf.challenge_rules')}</Text>
            {(ch.rules ?? []).map((rule, idx) => (
              <View key={idx} style={{ backgroundColor: c.paper, borderRadius: r.sm, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: c.line }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: c.ink }}>{rule.rule}</Text>
                {rule.description ? <Text style={{ fontSize: 12, color: c.mute, marginTop: 4 }}>{rule.description}</Text> : null}
                {rule.metric ? <Text style={{ fontSize: 11, color: c.cyan, marginTop: 4 }}>{rule.metric}{rule.threshold !== undefined ? ` ≥ ${rule.threshold}` : ''}</Text> : null}
              </View>
            ))}
            <Text style={{ fontSize: 15, fontWeight: '700', color: c.ink, marginTop: 14, marginBottom: 10 }}>{t('cf.challenge_evidence')}</Text>
            {(ch.eligible_evidence ?? []).map((ev, idx) => (
              <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.pink }} />
                <Text style={{ fontSize: 13, color: c.ink, fontWeight: '600' }}>
                  {t(`cf.challenge_evidence_${ev.kind === 'strava_activity' ? 'strava' : ev.kind}`) || ev.kind}
                </Text>
                {ev.description ? <Text style={{ fontSize: 12, color: c.mute }}>— {ev.description}</Text> : null}
              </View>
            ))}
          </View>
        )}
        {/* Leaderboard */}
        {tab === 'leaderboard' && leaderboard && (
          <View>
            {leaderboard.leaderboard.map((row) => (
              <View key={row.participant_id} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.paper, borderRadius: r.sm, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: c.line }}>
                <Text style={{ fontSize: 20, fontWeight: '700', color: row.rank === 1 ? '#FFD700' : c.mute, width: 36 }}>#{row.rank}</Text>
                <Text style={{ fontSize: 20, marginEnd: 10 }}>{row.avatar_emoji ?? '👤'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: c.ink }}>{row.display_name}</Text>
                </View>
                <Text style={{ fontSize: 14, fontWeight: '700', color: c.pink }}>{row.score}</Text>
              </View>
            ))}
            {leaderboard.leaderboard.length === 0 && <Text style={{ color: c.mute, textAlign: 'center', paddingTop: 30 }}>No verified entries yet</Text>}
          </View>
        )}
        {/* Entries placeholder */}
        {tab === 'entries' && (
          <View style={{ alignItems: 'center', paddingTop: 20 }}>
            <Text style={{ color: c.mute }}>Entries are reviewed by the organiser.</Text>
          </View>
        )}
        <View style={{ height: 90 }} />
      </ScrollView>
      {/* Enter / Submit Evidence */}
      {canEnter && (
        <View style={{ position: 'absolute', bottom: 0, insetInline: 0, padding: 16, backgroundColor: c.paper, borderTopWidth: 1, borderColor: c.line }}>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={enter}
            disabled={entering}
            style={{ backgroundColor: c.pink, borderRadius: r.full, padding: 16, alignItems: 'center', opacity: entering ? 0.7 : 1, minHeight: 52 }}
          >
            {entering ? <ActivityIndicator color={c.paper} /> : <Text style={{ fontSize: 16, fontWeight: '700', color: c.paper }}>{t('cf.challenge_enter')}</Text>}
          </TouchableOpacity>
        </View>
      )}
      {hasEntry && ch.my_entry?.status === 'entered' && (
        <View style={{ position: 'absolute', bottom: 0, insetInline: 0, padding: 16, backgroundColor: c.paper, borderTopWidth: 1, borderColor: c.line }}>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => navigation?.navigate('FeedChallengeEntry', { id })}
            style={{ backgroundColor: c.cyan, borderRadius: r.full, padding: 16, alignItems: 'center', minHeight: 52 }}
          >
            <Text style={{ fontSize: 16, fontWeight: '700', color: c.paper }}>{t('cf.challenge_submit_evidence')}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ── FeedChallengeCreate ────────────────────────────────────────────────────────
export function FeedChallengeCreate({ route, navigation }) {
  const { t } = useTranslation();
  const { org_id } = route?.params ?? {};
  const [form, setForm] = useState({ title: '', description: '', kind: 'activity', start_at: '', end_at: '', is_sponsored: false, disclosure_text: '', quota: '' });
  const [rules, setRules] = useState([{ rule: '', description: '' }]);
  const [evidence, setEvidence] = useState([{ kind: 'video', description: '' }]);
  const [saving, setSaving] = useState(false);

  const addRule = () => setRules((r) => [...r, { rule: '', description: '' }]);
  const addEvidence = () => setEvidence((e) => [...e, { kind: 'video', description: '' }]);

  const submit = async () => {
    if (!form.title || !form.start_at || !form.end_at) return;
    setSaving(true);
    try {
      const payload = {
        org_id, title: form.title, description: form.description || undefined,
        kind: form.kind, rules: rules.filter((r) => r.rule),
        eligible_evidence: evidence.filter((e) => e.kind),
        start_at: form.start_at, end_at: form.end_at,
        is_sponsored: form.is_sponsored,
        disclosure_text: form.is_sponsored ? form.disclosure_text : undefined,
        quota: form.quota ? parseInt(form.quota, 10) : undefined,
      };
      await api.post('/feed/challenges', payload);
      navigation?.goBack();
    } finally {
      setSaving(false);
    }
  };

  const kinds = ['participation_streak','activity','skill','community'];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: '700', color: c.ink, marginBottom: 16 }}>{t('cf.challenge_create')}</Text>

      <Text style={{ fontSize: 12, fontWeight: '600', color: c.mute, marginBottom: 4 }}>Title *</Text>
      <TextInput
        value={form.title}
        onChangeText={(v) => setForm((f) => ({ ...f, title: v }))}
        placeholder="e.g. 30-day Sprint Challenge"
        placeholderTextColor={c.mute}
        style={{ backgroundColor: c.paper, borderRadius: r.sm, borderWidth: 1, borderColor: c.line, padding: 12, color: c.ink, marginBottom: 12, fontSize: 15 }}
        accessibilityLabel="Challenge title"
      />

      <Text style={{ fontSize: 12, fontWeight: '600', color: c.mute, marginBottom: 4 }}>Description</Text>
      <TextInput
        value={form.description}
        onChangeText={(v) => setForm((f) => ({ ...f, description: v }))}
        multiline
        numberOfLines={3}
        placeholder="Describe the challenge..."
        placeholderTextColor={c.mute}
        style={{ backgroundColor: c.paper, borderRadius: r.sm, borderWidth: 1, borderColor: c.line, padding: 12, color: c.ink, marginBottom: 12, fontSize: 14, minHeight: 80, textAlignVertical: 'top' }}
        accessibilityLabel="Challenge description"
      />

      <Text style={{ fontSize: 12, fontWeight: '600', color: c.mute, marginBottom: 6 }}>Type</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {kinds.map((k) => (
          <Chip key={k} label={t(`cf.challenge_kind_${k}`)} active={form.kind === k} onPress={() => setForm((f) => ({ ...f, kind: k })} />
        ))}
      </View>

      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: c.mute, marginBottom: 4 }}>Start date *</Text>
          <TextInput value={form.start_at} onChangeText={(v) => setForm((f) => ({ ...f, start_at: v }))} placeholder="YYYY-MM-DDTHH:mm:ssZ" placeholderTextColor={c.mute} style={{ backgroundColor: c.paper, borderRadius: r.sm, borderWidth: 1, borderColor: c.line, padding: 12, color: c.ink, fontSize: 13 }} accessibilityLabel="Start date" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: c.mute, marginBottom: 4 }}>End date *</Text>
          <TextInput value={form.end_at} onChangeText={(v) => setForm((f) => ({ ...f, end_at: v }))} placeholder="YYYY-MM-DDTHH:mm:ssZ" placeholderTextColor={c.mute} style={{ backgroundColor: c.paper, borderRadius: r.sm, borderWidth: 1, borderColor: c.line, padding: 12, color: c.ink, fontSize: 13 }} accessibilityLabel="End date" />
        </View>
      </View>

      <Text style={{ fontSize: 14, fontWeight: '700', color: c.ink, marginBottom: 8 }}>{t('cf.challenge_rules')}</Text>
      {rules.map((rule, idx) => (
        <View key={idx} style={{ backgroundColor: c.paper, borderRadius: r.sm, borderWidth: 1, borderColor: c.line, padding: 10, marginBottom: 8 }}>
          <TextInput value={rule.rule} onChangeText={(v) => setRules((rs) => rs.map((r, i) => i === idx ? { ...r, rule: v } : r))} placeholder="Rule summary" placeholderTextColor={c.mute} style={{ color: c.ink, fontSize: 14, marginBottom: 6 }} accessibilityLabel={`Rule ${idx + 1}`} />
          <TextInput value={rule.description} onChangeText={(v) => setRules((rs) => rs.map((r, i) => i === idx ? { ...r, description: v } : r))} placeholder="Details..." placeholderTextColor={c.mute} style={{ color: c.mute, fontSize: 12 }} accessibilityLabel={`Rule ${idx + 1} description`} />
        </View>
      ))}
      <TouchableOpacity onPress={addRule} style={{ marginBottom: 14 }}><Text style={{ color: c.pink, fontWeight: '600' }}>+ Add rule</Text></TouchableOpacity>

      <Text style={{ fontSize: 14, fontWeight: '700', color: c.ink, marginBottom: 8 }}>{t('cf.challenge_evidence')}</Text>
      {evidence.map((ev, idx) => (
        <View key={idx} style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
          {['video','photo','strava_activity','manual'].map((kind) => (
            <Chip key={kind} label={t(`cf.challenge_evidence_${kind === 'strava_activity' ? 'strava' : kind}`)} active={ev.kind === kind} onPress={() => setEvidence((es) => es.map((e, i) => i === idx ? { ...e, kind } : e))} />
          ))}
        </View>
      ))}
      <TouchableOpacity onPress={addEvidence} style={{ marginBottom: 14 }}><Text style={{ color: c.pink, fontWeight: '600' }}>+ Add evidence type</Text></TouchableOpacity>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <Text style={{ fontSize: 14, fontWeight: '600', color: c.ink }}>{t('cf.challenge_sponsored_badge')}</Text>
        <Switch value={form.is_sponsored} onValueChange={(v) => setForm((f) => ({ ...f, is_sponsored: v }))} accessibilityLabel="Sponsored toggle" />
      </View>
      {form.is_sponsored && (
        <TextInput value={form.disclosure_text} onChangeText={(v) => setForm((f) => ({ ...f, disclosure_text: v }))} placeholder="e.g. Paid partnership with Acme Sports" placeholderTextColor={c.mute} style={{ backgroundColor: c.paper, borderRadius: r.sm, borderWidth: 1, borderColor: c.violet, padding: 12, color: c.ink, marginBottom: 12, fontSize: 13 }} accessibilityLabel="Sponsorship disclosure" />
      )}

      <TouchableOpacity
        onPress={submit}
        disabled={saving}
        style={{ backgroundColor: c.pink, borderRadius: r.full, padding: 16, alignItems: 'center', marginTop: 10, minHeight: 52, opacity: saving ? 0.7 : 1 }}
        accessibilityRole="button"
      >
        {saving ? <ActivityIndicator color={c.paper} /> : <Text style={{ fontSize: 16, fontWeight: '700', color: c.paper }}>{t('cf.challenge_create')}</Text>}
      </TouchableOpacity>
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

// ── FeedChallengeEntry ─────────────────────────────────────────────────────────
export function FeedChallengeEntry({ route, navigation }) {
  const { t } = useTranslation();
  const { id: challengeId } = route?.params ?? {};
  const [ch, setCh] = useState(null);
  const [entry, setEntry] = useState(null);
  const [evidenceKind, setEvidenceKind] = useState('video');
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!challengeId) return;
    api.get(`/feed/challenges/${challengeId}`).then((ch) => {
      setCh(ch);
      if (ch.my_entry) setEntry(ch.my_entry);
    });
  }, [challengeId]);

  const submit = async () => {
    if (!url || !entry?.id) return;
    setSubmitting(true);
    try {
      await api.patch(`/feed/challenges/${challengeId}/entries/${entry.id}`, { evidence_url: url, evidence_kind: evidenceKind });
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  if (!ch) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}><ActivityIndicator color={c.pink} /></View>;
  if (submitted) return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg, padding: 24 }}>
      <Text style={{ fontSize: 32, marginBottom: 12 }}>✅</Text>
      <Text style={{ fontSize: 18, fontWeight: '700', color: c.ink, textAlign: 'center', marginBottom: 8 }}>Evidence submitted!</Text>
      <Text style={{ fontSize: 14, color: c.mute, textAlign: 'center' }}>The organiser will review your entry and update the leaderboard.</Text>
      <TouchableOpacity onPress={() => navigation?.goBack()} style={{ marginTop: 24, backgroundColor: c.pink, borderRadius: r.full, paddingHorizontal: 28, paddingVertical: 14 }}>
        <Text style={{ color: c.paper, fontWeight: '700', fontSize: 15 }}>Done</Text>
      </TouchableOpacity>
    </View>
  );

  const evidenceKinds = ['video','photo','strava_activity','manual'];
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: '700', color: c.ink, marginBottom: 4 }}>{t('cf.challenge_submit_evidence')}</Text>
      <Text style={{ fontSize: 14, color: c.mute, marginBottom: 20 }}>{ch.title}</Text>

      <Text style={{ fontSize: 14, fontWeight: '600', color: c.ink, marginBottom: 8 }}>Evidence type</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {evidenceKinds.map((kind) => (
          <Chip key={kind} label={t(`cf.challenge_evidence_${kind === 'strava_activity' ? 'strava' : kind}`)} active={evidenceKind === kind} onPress={() => setEvidenceKind(kind)} />
        ))}
      </View>

      <Text style={{ fontSize: 14, fontWeight: '600', color: c.ink, marginBottom: 6 }}>{t('cf.challenge_evidence_url')}</Text>
      <TextInput
        value={url}
        onChangeText={setUrl}
        placeholder={evidenceKind === 'manual' ? 'Describe your activity...' : 'https://...'}
        placeholderTextColor={c.mute}
        multiline={evidenceKind === 'manual'}
        numberOfLines={evidenceKind === 'manual' ? 4 : 1}
        style={{ backgroundColor: c.paper, borderRadius: r.sm, borderWidth: 1, borderColor: c.line, padding: 12, color: c.ink, fontSize: 14, marginBottom: 24, minHeight: evidenceKind === 'manual' ? 100 : 48, textAlignVertical: 'top' }}
        accessibilityLabel="Evidence URL or reference"
      />

      <TouchableOpacity
        onPress={submit}
        disabled={submitting || !url}
        style={{ backgroundColor: c.pink, borderRadius: r.full, padding: 16, alignItems: 'center', opacity: (submitting || !url) ? 0.7 : 1, minHeight: 52 }}
        accessibilityRole="button"
      >
        {submitting ? <ActivityIndicator color={c.paper} /> : <Text style={{ fontSize: 16, fontWeight: '700', color: c.paper }}>{t('cf.challenge_submit_evidence')}</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}
