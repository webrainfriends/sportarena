// Peer Skill Graph — distribution, request flow, assessment form (issue #1190).
// Peers rate sport-specific skill dimensions; Glicko ratings are NEVER touched here.
// Privacy threshold k≥5: distribution suppressed below that count.
import React, { useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Chip, ErrorBox, Loading, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { t } from '../i18n';
import { c, day } from '../theme';

const DIMENSIONS = () => [
  { key: 'technique', label: t('psg.dim_technique') },
  { key: 'tactical_iq', label: t('psg.dim_tactical') },
  { key: 'consistency', label: t('psg.dim_consistency') },
  { key: 'physical', label: t('psg.dim_physical') },
  { key: 'mental_strength', label: t('psg.dim_mental') },
  { key: 'fair_play', label: t('psg.dim_fair_play') },
];

const BUCKETS = () => [
  { value: 1, label: t('psg.bucket_1') },
  { value: 2, label: t('psg.bucket_2') },
  { value: 3, label: t('psg.bucket_3') },
  { value: 4, label: t('psg.bucket_4') },
  { value: 5, label: t('psg.bucket_5') },
];

const CONFIDENCE = () => [
  { value: 'low', label: t('psg.conf_low') },
  { value: 'medium', label: t('psg.conf_medium') },
  { value: 'high', label: t('psg.conf_high') },
];

const BAR_COLORS = ['#EF4444', '#F59E0B', '#3B82F6', '#8458B3', '#22C55E'];

function RingProgress({ count, threshold }) {
  const pct = Math.min(count / threshold, 1);
  const size = 88;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const filled = circ * pct;
  const gap = circ - filled;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: stroke, borderColor: c.line }} />
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: stroke, borderColor: c.pink,
        borderTopColor: pct > 0.75 ? c.pink : 'transparent',
        borderRightColor: pct > 0.5 ? c.pink : 'transparent',
        borderBottomColor: pct > 0.25 ? c.pink : 'transparent',
        borderLeftColor: pct > 0 ? c.pink : 'transparent',
        transform: [{ rotate: '-90deg' }] }} />
      <T weight="900" size={22} color={c.pink}>{count}</T>
      <T size={10} color={c.mute}>/{threshold}</T>
    </View>
  );
}

function DimensionBar({ label, score, maxScore = 5, color }) {
  const pct = Math.min((score / maxScore) * 100, 100);
  return (
    <View style={{ gap: 4, marginBottom: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <T size={13} weight="700">{label}</T>
        <T size={13} weight="800" color={color ?? c.pink}>{score?.toFixed(1) ?? '—'}</T>
      </View>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: c.line, overflow: 'hidden' }}>
        <View style={{ width: `${pct}%`, height: 8, borderRadius: 4, backgroundColor: color ?? c.pink }} />
      </View>
    </View>
  );
}

function SparklineTrend({ points }) {
  if (!points || points.length < 2) return null;
  const vals = points.map((p) => p.score);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const W = 120, H = 28;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * W;
    const y = H - ((p.score - lo) / span) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const trend = vals.at(-1) > vals[0] ? '↑' : vals.at(-1) < vals[0] ? '↓' : '→';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ width: W, height: H, backgroundColor: c.violetSoft, borderRadius: 6, overflow: 'hidden' }}>
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 2, backgroundColor: c.line }} />
        {points.map((p, i) => {
          const x = (i / (points.length - 1)) * W;
          const y = H - ((p.score - lo) / span) * (H - 4) - 2;
          return <View key={i} style={{ position: 'absolute', width: 5, height: 5, borderRadius: 2.5, backgroundColor: c.pink, left: x - 2.5, top: y - 2.5 }} />;
        })}
      </View>
      <T size={18} color={trend === '↑' ? c.mint : trend === '↓' ? c.red : c.mute}>{trend}</T>
      <T size={12} color={c.mute}>{t('psg.trend_months', { n: points.length })}</T>
    </View>
  );
}

function SuppressedState({ data, userId, sportSlug, isOwn, onInvite }) {
  const raters = data?.eligible_count ?? 0;
  const threshold = data?.threshold ?? 5;
  const pending = data?.pending_requests ?? [];
  const whoCanRate = [
    { role: t('psg.role_coplayer'), allowed: true },
    { role: t('psg.role_coach'), allowed: true },
    { role: t('psg.role_official'), allowed: true },
    { role: t('psg.role_visitor'), allowed: false },
  ];
  return (
    <View style={{ gap: 16 }}>
      <Card pad={16}>
        <View style={{ alignItems: 'center', gap: 12, paddingVertical: 8 }}>
          <RingProgress count={raters} threshold={threshold} />
          <T weight="800" size={16} style={{ textAlign: 'center' }}>{t('psg.suppressed_title')}</T>
          <T size={13} color={c.mute} style={{ textAlign: 'center', lineHeight: 19 }}>{t('psg.suppressed_sub', { n: threshold - raters })}</T>
          {isOwn ? <Btn small title={`+ ${t('psg.invite_btn')}`} onPress={onInvite} /> : null}
        </View>
      </Card>
      {pending.length > 0 ? (
        <View>
          <T weight="700" size={13} color={c.mute} style={{ marginBottom: 8, letterSpacing: 0.5 }}>{t('psg.pending_title').toUpperCase()}</T>
          <View style={{ gap: 8 }}>
            {pending.map((req) => (
              <Card key={req.id} pad={12}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}>
                    <T weight="800" size={14} color={c.pink}>{(req.name ?? '?')[0]}</T>
                  </View>
                  <View style={{ flex: 1 }}>
                    <T weight="700" size={14}>{req.name}</T>
                    <T size={12} color={c.mute}>{t('psg.invited_ago', { days: req.days_ago })}</T>
                  </View>
                  <Tag label={req.status} color={req.status === 'accepted' ? c.mintSoft : c.mute} />
                </View>
              </Card>
            ))}
          </View>
        </View>
      ) : null}
      <Card pad={14}>
        <T weight="700" size={13} style={{ marginBottom: 8 }}>{t('psg.who_can_rate')}</T>
        {whoCanRate.map((w) => (
          <View key={w.role} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderTopWidth: 1, borderColor: c.line }}>
            <T size={13} style={{ flex: 1 }}>{w.role}</T>
            <T size={16} color={w.allowed ? c.mint : c.red}>{w.allowed ? '✓' : '✗'}</T>
          </View>
        ))}
      </Card>
    </View>
  );
}

function PopulatedState({ data, isOwn, onInvite }) {
  const dims = DIMENSIONS();
  const dist = data?.distribution ?? {};
  return (
    <View style={{ gap: 16 }}>
      <Card pad={16}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <View style={{ flex: 1 }}>
            <T weight="900" size={20} color={c.pink}>{data.overall?.toFixed(1) ?? '—'}</T>
            <T size={12} color={c.mute}>{t('psg.overall_label')}</T>
          </View>
          {data.cohort_percentile ? (
            <View style={{ backgroundColor: c.violetSoft, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}>
              <T weight="800" size={13} color={c.pink}>{t('psg.top_pct', { pct: data.cohort_percentile })}</T>
              <T size={10} color={c.mute}>{t('psg.of_players', { n: data.cohort_size, level: data.level_label })}</T>
            </View>
          ) : null}
        </View>
        <SparklineTrend points={data.trend ?? []} />
        <T size={11.5} color={c.mute} style={{ marginTop: 8 }}>{t('psg.rater_count', { n: data.eligible_count ?? 0 })} · {t('psg.as_of', { date: day(data.as_of) })}</T>
      </Card>
      <Card pad={14}>
        <T weight="700" size={13} style={{ marginBottom: 12 }}>{t('psg.dimensions_title')}</T>
        {dims.map((d, i) => {
          const score = dist[d.key]?.average ?? 0;
          return <DimensionBar key={d.key} label={d.label} score={score} color={BAR_COLORS[i % BAR_COLORS.length]} />;
        })}
      </Card>
      <Card pad={14}>
        <T weight="700" size={13} style={{ marginBottom: 8 }}>{t('psg.detail_table')}</T>
        {dims.map((d) => {
          const dim = dist[d.key];
          if (!dim) return null;
          return (
            <View key={d.key} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderColor: c.line }}>
              <T size={13} style={{ flex: 1 }}>{d.label}</T>
              <T size={13} weight="800" color={c.pink} style={{ width: 36 }}>{dim.average?.toFixed(1)}</T>
              <Tag label={dim.level_label ?? ''} color={c.cyanSoft} />
            </View>
          );
        })}
      </Card>
      {isOwn ? (
        <Btn small title={`+ ${t('psg.invite_more')}`} onPress={onInvite} />
      ) : null}
    </View>
  );
}

export function PeerSkillGraphPanel({ userId, sportSlug, isOwn }) {
  const [inviting, setInviting] = useState(false);
  const data = useLoad(() => api.get(`/athletes/${userId}/sports/${sportSlug}/peer-skill`), [userId, sportSlug]);

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} onRetry={data.reload} />;
  const d = data.data;
  const suppressed = !d || d.suppressed;

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
        <T weight="900" size={16} style={{ flex: 1 }}>{t('psg.section_title')}</T>
        {!suppressed ? <Tag label={t('psg.verified_label')} color={c.mintSoft} /> : null}
      </View>
      {suppressed
        ? <SuppressedState data={d} userId={userId} sportSlug={sportSlug} isOwn={isOwn} onInvite={() => setInviting(true)} />
        : <PopulatedState data={d} isOwn={isOwn} onInvite={() => setInviting(true)} />}
      {inviting ? <RequestFeedbackSheet visible onClose={() => setInviting(false)} sportSlug={sportSlug} onSent={() => { setInviting(false); data.reload(); }} /> : null}
    </View>
  );
}

export function RequestFeedbackSheet({ visible, onClose, sportSlug, onSent }) {
  const { toast } = useSession();
  const contacts = useLoad(() => api.get(`/me/sports/${sportSlug}/eligible-raters`), [sportSlug]);
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState('');
  const [sending, setSending] = useState(false);

  const toggle = (id) => setSelected((s) => s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
  const filtered = (contacts.data?.contacts ?? []).filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase()));

  const send = async () => {
    if (!selected.length) return;
    setSending(true);
    try {
      await api.post(`/me/sports/${sportSlug}/request-feedback`, { invitee_ids: selected });
      toast(t('psg.sent_toast', { n: selected.length }));
      onSent?.();
    } catch (e) {
      toast(e.message);
    } finally {
      setSending(false);
    }
  };

  if (!visible) return null;
  return (
    <View style={{ flex: 1, backgroundColor: c.canvas }}>
      <View style={{ padding: 20, flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
          <T weight="900" size={16} style={{ flex: 1 }}>{t('psg.invite_sheet_title')}</T>
          <Pressable hitSlop={12} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('psg.close')}><T size={22} color={c.mute}>✕</T></Pressable>
        </View>
        <T size={13} color={c.mute} style={{ marginBottom: 12 }}>{t('psg.invite_sheet_sub')}</T>
        <TextInput value={search} onChangeText={setSearch} placeholder={t('psg.search_placeholder')} placeholderTextColor={c.mute} style={{ borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 10, fontSize: 14, color: c.fg, marginBottom: 12, minHeight: 44 }} accessibilityLabel={t('psg.search_placeholder')} />
        {contacts.loading ? <Loading /> : (
          <ScrollView style={{ flex: 1 }}>
            {filtered.length === 0 ? (
              <View style={{ padding: 20, alignItems: 'center' }}>
                <T size={13} color={c.mute}>{t('psg.no_contacts')}</T>
              </View>
            ) : filtered.map((contact) => (
              <Pressable key={contact.id} onPress={() => toggle(contact.id)} accessibilityRole="checkbox" accessibilityState={{ checked: selected.includes(contact.id) }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderBottomWidth: 1, borderColor: c.line, minHeight: 56 }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}>
                  <T weight="800" size={15} color={c.pink}>{(contact.name ?? '?')[0]}</T>
                </View>
                <View style={{ flex: 1 }}>
                  <T weight="700" size={14}>{contact.name}</T>
                  <T size={12} color={c.mute}>{contact.eligibility_label}</T>
                </View>
                <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: selected.includes(contact.id) ? c.pink : c.line, backgroundColor: selected.includes(contact.id) ? c.pink : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                  {selected.includes(contact.id) ? <T size={13} color="#fff" weight="900">✓</T> : null}
                </View>
              </Pressable>
            ))}
          </ScrollView>
        )}
        <View style={{ paddingTop: 12 }}>
          <Btn title={sending ? t('psg.sending') : t('psg.send_requests', { n: selected.length })} onPress={send} disabled={sending || !selected.length} />
        </View>
      </View>
    </View>
  );
}

export function SubmitPeerAssessmentSheet({ visible, onClose, athleteId, athleteName, sportSlug, requestToken }) {
  const { toast } = useSession();
  const dims = DIMENSIONS();
  const [overall, setOverall] = useState(0);
  const [criteria, setCriteria] = useState(() => dims.map((d) => ({ key: d.key, bucket: 0, not_observed: false })));
  const [feedback, setFeedback] = useState('');
  const [confidence, setConfidence] = useState('medium');
  const [submitting, setSubmitting] = useState(false);
  const policy = useLoad(() => api.get(`/sports/${sportSlug}/peer-rating-policy`), [sportSlug]);

  const updateCriterion = (key, field, val) => {
    setCriteria((prev) => prev.map((c) => c.key === key ? { ...c, [field]: val } : c));
  };

  const submit = async () => {
    if (!overall) { toast(t('psg.error_overall')); return; }
    setSubmitting(true);
    try {
      await api.post('/peer-assessments', {
        athlete_id: athleteId,
        sport_slug: sportSlug,
        request_token: requestToken,
        overall_bucket: overall,
        criteria,
        constructive_feedback: feedback || undefined,
        confidence,
      });
      toast(t('psg.submitted_toast'));
      onClose?.();
    } catch (e) {
      toast(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!visible) return null;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.canvas }}>
      <View style={{ padding: 20, gap: 20 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <T weight="900" size={16} style={{ flex: 1 }}>{t('psg.assess_title', { name: athleteName })}</T>
          <Pressable hitSlop={12} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('psg.close')}><T size={22} color={c.mute}>✕</T></Pressable>
        </View>
        {policy.data?.submission_window_days ? (
          <View style={{ backgroundColor: c.cyanSoft, borderRadius: 8, padding: 12 }}>
            <T size={12.5} color={c.cyan}>{t('psg.window_note', { days: policy.data.submission_window_days })}</T>
          </View>
        ) : null}
        <View>
          <T weight="700" size={14} style={{ marginBottom: 10 }}>{t('psg.overall_title')}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {BUCKETS().map((b) => (
              <Pressable key={b.value} onPress={() => setOverall(b.value)} accessibilityRole="radio" accessibilityState={{ selected: overall === b.value }}
                style={{ flex: 1, minWidth: 80, padding: 12, borderRadius: 10, borderWidth: overall === b.value ? 2 : 1, borderColor: overall === b.value ? c.pink : c.line, alignItems: 'center', minHeight: 56 }}>
                <T weight="800" size={18} color={overall === b.value ? c.pink : c.fg}>{b.value}</T>
                <T size={11} color={c.mute} style={{ textAlign: 'center' }}>{b.label}</T>
              </Pressable>
            ))}
          </View>
        </View>
        <View>
          <T weight="700" size={14} style={{ marginBottom: 10 }}>{t('psg.dimensions_assess')}</T>
          {dims.map((d, idx) => {
            const crit = criteria[idx];
            return (
              <Card key={d.key} pad={12} style={{ marginBottom: 8 }}>
                <T weight="700" size={13} style={{ marginBottom: 8 }}>{d.label}</T>
                <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
                  {[1, 2, 3, 4, 5].map((v) => (
                    <Pressable key={v} onPress={() => updateCriterion(d.key, 'bucket', v)} disabled={crit.not_observed}
                      accessibilityRole="radio" accessibilityState={{ selected: crit.bucket === v }}
                      style={{ flex: 1, height: 36, borderRadius: 6, borderWidth: crit.bucket === v ? 2 : 1, borderColor: crit.bucket === v ? c.pink : c.line, alignItems: 'center', justifyContent: 'center', opacity: crit.not_observed ? 0.4 : 1 }}>
                      <T size={14} weight={crit.bucket === v ? '800' : '400'} color={crit.bucket === v ? c.pink : c.fg}>{v}</T>
                    </Pressable>
                  ))}
                </View>
                <Pressable onPress={() => updateCriterion(d.key, 'not_observed', !crit.not_observed)} accessibilityRole="checkbox" accessibilityState={{ checked: crit.not_observed }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 }}>
                  <View style={{ width: 18, height: 18, borderRadius: 3, borderWidth: 1.5, borderColor: crit.not_observed ? c.mute : c.line, backgroundColor: crit.not_observed ? c.mute : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                    {crit.not_observed ? <T size={11} color="#fff">✓</T> : null}
                  </View>
                  <T size={12.5} color={c.mute}>{t('psg.not_observed')}</T>
                </Pressable>
              </Card>
            );
          })}
        </View>
        <View>
          <T weight="700" size={14} style={{ marginBottom: 8 }}>{t('psg.feedback_label')}</T>
          <TextInput value={feedback} onChangeText={setFeedback} multiline placeholder={t('psg.feedback_placeholder')} placeholderTextColor={c.mute}
            style={{ borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 12, fontSize: 14, color: c.fg, minHeight: 80, lineHeight: 20 }} accessibilityLabel={t('psg.feedback_label')} />
          <T size={12} color={c.mute} style={{ marginTop: 4 }}>{t('psg.feedback_hint')}</T>
        </View>
        <View>
          <T weight="700" size={14} style={{ marginBottom: 8 }}>{t('psg.confidence_label')}</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {CONFIDENCE().map((opt) => (
              <Chip key={opt.value} label={opt.label} active={confidence === opt.value} onPress={() => setConfidence(opt.value)} />
            ))}
          </View>
        </View>
        <View style={{ backgroundColor: c.mute + '22', borderRadius: 8, padding: 12 }}>
          <T size={12} color={c.mute}>{t('psg.privacy_note')}</T>
        </View>
        <Btn title={submitting ? t('psg.submitting') : t('psg.submit_btn')} onPress={submit} disabled={submitting || !overall} />
      </View>
    </ScrollView>
  );
}
