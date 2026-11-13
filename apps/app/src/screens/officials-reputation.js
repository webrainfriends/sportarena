// Issue #1024: verified, moderated referee reputation — testimony, visibility prefs, anti-retaliation.
// Self view, public card, testimony management, referee badge verification.
import React, { useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, GradCard, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { c, grad } from '../theme';
import { t } from '../i18n';
import { VerificationSection } from './verification';

const DIMENSIONS = ['completed_matches','on_time_rate','feedback_averages','assessments','cpd','grade','testimony'];
const FEEDBACK_CRITERIA = ['communication','consistency','game_control','positioning_fitness','conduct'];
const VIS_OPTIONS = [
  { value: 'public', label: t('reputation.visibility.public') },
  { value: 'organiser_only', label: t('reputation.visibility.organiser_only') },
  { value: 'private', label: t('reputation.visibility.private') },
];

function KpiTile({ value, label, tone }) {
  return (
    <View style={{ flex: 1, minWidth: 80, alignItems: 'center', backgroundColor: c.card, borderRadius: 10, padding: 12 }}>
      <T size={24} weight="800" color={tone ?? c.heading}>{value ?? '—'}</T>
      <T size={11} color={c.mute} style={{ marginTop: 2, textAlign: 'center' }}>{label}</T>
    </View>
  );
}

function CriterionBar({ label, value, max = 5 }) {
  const pct = max > 0 ? Math.min(1, (value ?? 0) / max) : 0;
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <T size={12.5} color={c.text}>{label}</T>
        <T size={12.5} weight="700" color={c.violet}>{value != null ? value.toFixed(1) : '—'}</T>
      </View>
      <View style={{ height: 6, backgroundColor: c.border, borderRadius: 3 }}>
        <View style={{ width: `${pct * 100}%`, height: 6, backgroundColor: c.violet, borderRadius: 3 }} />
      </View>
    </View>
  );
}

function VisibilityRow({ dimension, value, onChange }) {
  const dimLabel = t(`reputation.dimension.${dimension}`);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 8 }}>
      <T size={13} color={c.text} style={{ flex: 1 }}>{dimLabel}</T>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {VIS_OPTIONS.map((o) => (
          <Pressable
            key={o.value}
            accessibilityLabel={`${dimLabel} ${o.label}`}
            style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
              backgroundColor: value === o.value ? c.violet : c.card,
              borderWidth: 1, borderColor: value === o.value ? c.violet : c.border,
              minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
            onPress={() => onChange(dimension, o.value)}
          >
            <T size={11} weight="600" color={value === o.value ? '#fff' : c.mute}>{o.label}</T>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function HubTab({ profile, reload }) {
  const [saving, setSaving] = useState(false);
  const matches = profile.completed_matches;
  const onTime = matches?.total > 0 ? Math.round((matches.on_time / matches.total) * 100) : null;
  const fb = profile.feedback;
  const assess = profile.assessments;
  const cpd = profile.cpd;
  const grade = profile.grade;
  const vis = profile.visibility ?? {};

  async function handleVisChange(dim, newVal) {
    setSaving(true);
    try {
      await api.put('/official-reputation/visibility', { dimension: dim, visibility: newVal });
      await reload();
    } finally { setSaving(false); }
  }

  return (
    <View style={{ gap: 14 }}>
      <Section title={t('reputation.hub')} color={c.violet}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <KpiTile value={matches?.total ?? 0} label={t('reputation.dimension.completed_matches')} />
          <KpiTile value={onTime != null ? `${onTime}%` : '—'} label={t('reputation.dimension.on_time_rate')} />
          <KpiTile value={profile.years_active ?? 0} label={t('reputation.kpi.years_active')} />
          <KpiTile value={grade?.level ?? '—'} label={t('reputation.dimension.grade')} tone={c.amberText} />
        </View>
      </Section>

      {fb?.enough ? (
        <Section title={t('reputation.section.feedback')} color={c.violet}>
          <Card>
            <View style={{ gap: 10 }}>
              {FEEDBACK_CRITERIA.map((cr) => (
                <CriterionBar key={cr} label={t(`reputation.criterion.${cr}`)} value={fb.averages?.[cr]} />
              ))}
              <T size={11} color={c.mute} style={{ marginTop: 4 }}>{t('reputation.feedback.based_on', { n: fb.count })}</T>
            </View>
          </Card>
        </Section>
      ) : (
        <Section title={t('reputation.section.feedback')} color={c.violet}>
          <Card>
            <Empty label={t('reputation.empty.building_with_count', { n: matches?.total ?? 0, min: 3 })} />
          </Card>
        </Section>
      )}

      {assess && (
        <Section title={t('reputation.section.assessments')} color={c.violet}>
          <Card>
            <View style={{ flexDirection: 'row', gap: 16 }}>
              <View style={{ flex: 1 }}>
                <T size={22} weight="800" color={c.violet}>{assess.published}</T>
                <T size={12} color={c.mute}>{t('reputation.assessments.published')}</T>
              </View>
              {assess.upheld > 0 && (
                <View style={{ flex: 1 }}>
                  <T size={22} weight="800" color={c.amberText}>{assess.upheld}</T>
                  <T size={12} color={c.mute}>{t('reputation.assessments.upheld_appeals')}</T>
                </View>
              )}
            </View>
          </Card>
        </Section>
      )}

      {cpd && (
        <Section title={t('reputation.section.cpd')} color={c.violet}>
          <Card>
            <T size={22} weight="800" color={c.violet}>{cpd.verified_hours} hrs</T>
            <T size={12} color={c.mute}>{t('reputation.cpd.verified')}</T>
          </Card>
        </Section>
      )}

      {grade?.licence_type && (
        <Section title={t('reputation.section.grade')} color={c.violet}>
          <Card>
            <View style={{ gap: 6 }}>
              <Tag label={grade.licence_type} color={c.violetSoft} />
              {grade.body_name && <T size={13} color={c.mute}>{grade.body_name}</T>}
              {grade.expires_on && <T size={12} color={c.mute}>{t('reputation.grade.expires', { date: String(grade.expires_on).slice(0, 10) })}</T>}
            </View>
          </Card>
        </Section>
      )}

      <Section title={t('reputation.section.visibility')} color={c.violet}>
        <Card>
          <T size={12} color={c.mute} style={{ marginBottom: 8 }}>{t('reputation.visibility.hint')}</T>
          {DIMENSIONS.map((dim) => (
            <VisibilityRow key={dim} dimension={dim} value={vis[dim] ?? 'organiser_only'} onChange={handleVisChange} />
          ))}
          {saving && <T size={12} color={c.mute}>{t('common.saving')}</T>}
        </Card>
      </Section>
    </View>
  );
}

function DisputeSheet({ testimony, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  async function submit() {
    if (reason.length < 20) { setErr(t('reputation.dispute.reason_min')); return; }
    setLoading(true);
    try {
      await api.post(`/official-reputation/testimony/${testimony.id}/dispute`, { reason });
      onDone();
    } catch (e) {
      setErr(e.message ?? t('common.error'));
    } finally { setLoading(false); }
  }
  return (
    <Sheet onClose={onClose} title={t('reputation.dispute.title')}>
      <T size={13} color={c.mute} style={{ marginBottom: 8 }}>{t('reputation.dispute.intro')}</T>
      <T size={12} weight="600" color={c.text} style={{ marginBottom: 4 }}>{t('reputation.dispute.reason_label')}</T>
      <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10, minHeight: 100 }}>
        <T size={13} color={c.text}>{reason}</T>
      </View>
      {err ? <T size={12} color={c.error}>{err}</T> : null}
      <Btn label={t('reputation.dispute.submit')} loading={loading} onPress={submit} style={{ marginTop: 12 }} />
      <T size={11} color={c.mute} style={{ marginTop: 8 }}>{t('reputation.dispute.anti_retaliation_note')}</T>
    </Sheet>
  );
}

function TestimonyTab({ profile, reload }) {
  const [disputing, setDisputing] = useState(null);
  const testimony = profile.testimony ?? [];
  const pending = testimony.filter((t) => t.status === 'pending_dispute');
  const active = testimony.filter((t) => t.status === 'active');
  const hidden = testimony.filter((t) => t.status === 'hidden');

  function windowCountdown(endsAt) {
    const ms = new Date(endsAt) - Date.now();
    if (ms <= 0) return t('reputation.dispute.window_closed');
    const h = Math.floor(ms / 3600000);
    const d = Math.floor(h / 24);
    return d > 0 ? t('reputation.dispute.window_days', { d }) : t('reputation.dispute.window_hours', { h });
  }

  return (
    <View style={{ gap: 14 }}>
      {pending.length > 0 && (
        <Section title={t('reputation.testimony.pending_title')} color={c.amber}>
          {pending.map((item) => (
            <Card key={item.id} style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Tag label={windowCountdown(item.dispute_window_ends_at)} color={c.amberSoft} />
                <Chip label={t('reputation.dispute.submit')} onPress={() => setDisputing(item)} />
              </View>
              <T size={13} color={c.text} numberOfLines={4}>{item.body}</T>
              <T size={11} color={c.mute}>{t('reputation.testimony.anonymous_note')}</T>
            </Card>
          ))}
        </Section>
      )}

      {active.length > 0 ? (
        <Section title={t('reputation.testimony.active_title')} color={c.violet}>
          {active.map((item) => (
            <Card key={item.id} style={{ gap: 6 }}>
              <T size={13} color={c.text}>{item.body}</T>
              {item.author_grade?.licence_type && <Tag label={item.author_grade.licence_type} color={c.violetSoft} />}
              <T size={11} color={c.mute}>{t('reputation.testimony.published_on', { date: item.published_at?.slice(0,10) })}</T>
            </Card>
          ))}
        </Section>
      ) : (
        <Section title={t('reputation.testimony.active_title')} color={c.violet}>
          <Empty label={t('reputation.empty.no_testimony_yet')} />
        </Section>
      )}

      {hidden.length > 0 && (
        <Section title={t('reputation.testimony.hidden_title')} color={c.mute}>
          {hidden.map((item) => (
            <Card key={item.id} style={{ gap: 6 }}>
              <Tag label={t('reputation.testimony.hidden_by_moderation')} color={c.border} />
              {item.moderation_reason && <T size={12} color={c.mute}>{item.moderation_reason}</T>}
            </Card>
          ))}
        </Section>
      )}

      <Section title={t('reputation.policy.title')} color={c.mute}>
        <Card>
          <T size={12.5} color={c.mute}>{t('reputation.policy.body')}</T>
        </Card>
      </Section>

      {disputing && (
        <DisputeSheet
          testimony={disputing}
          onClose={() => setDisputing(null)}
          onDone={() => { setDisputing(null); reload(); }}
        />
      )}
    </View>
  );
}

function PublicCardTab({ userId }) {
  const q = useLoad(() => api.get(`/official-reputation/${userId}`), [userId]);
  if (!q.data && !q.error) return <Loading />;
  if (q.error) return (
    <Card><T color={c.mute}>{t('reputation.card.not_public')}</T></Card>
  );
  const p = q.data;
  const fb = p.feedback;
  const testimony = p.testimony ?? [];
  return (
    <View style={{ gap: 14 }}>
      <GradCard colors={grad.hero}>
        <View style={{ gap: 8 }}>
          <T size={12} weight="800" color="#fff" style={{ letterSpacing: 0.6 }}>{t('reputation.card.title')}</T>
          <T size={22} weight="800" color="#fff">{p.user?.display_name ?? '—'}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {p.grade?.licence_type && <Tag label={p.grade.licence_type} color="rgba(255,255,255,0.3)" />}
            {p.completed_matches?.total != null && <Tag label={`${p.completed_matches.total} ${t('reputation.kpi.matches')}`} color="rgba(255,255,255,0.2)" />}
            {p.years_active > 0 && <Tag label={`${p.years_active} ${t('reputation.kpi.years')}`} color="rgba(255,255,255,0.2)" />}
          </View>
        </View>
      </GradCard>

      {fb?.enough && (
        <Section title={t('reputation.section.feedback')} color={c.violet}>
          <Card>
            <View style={{ gap: 10 }}>
              {FEEDBACK_CRITERIA.map((cr) => (
                <CriterionBar key={cr} label={t(`reputation.criterion.${cr}`)} value={fb.averages?.[cr]} />
              ))}
            </View>
          </Card>
        </Section>
      )}

      {testimony.length > 0 && (
        <Section title={t('reputation.testimony.active_title')} color={c.violet}>
          {testimony.slice(0, 3).map((item) => (
            <Card key={item.id} style={{ gap: 6 }}>
              <T size={13} color={c.text} numberOfLines={6}>{item.body}</T>
              {item.author_grade?.licence_type && <Tag label={item.author_grade.licence_type} color={c.violetSoft} />}
            </Card>
          ))}
        </Section>
      )}
    </View>
  );
}

function BadgeTab({ userId }) {
  return (
    <View style={{ gap: 14 }}>
      <Section title={t('reputation.badge.title')} color={c.violet}>
        <VerificationSection userId={userId} type="referee" />
      </Section>
      <Section title={t('reputation.badge.evidence_title')} color={c.violet}>
        <Card>
          <T size={13} color={c.mute}>{t('reputation.badge.evidence_hint')}</T>
        </Card>
      </Section>
    </View>
  );
}

export function OfficialsReputation({ userId: propUserId }) {
  const { user } = useSession();
  const userId = propUserId ?? user?.id;
  const L = useLayout();
  const [tab, setTab] = useState('hub');
  const isSelf = userId === user?.id;
  const q = useLoad(() => api.get('/official-reputation/me'), [], { skip: !isSelf });
  const pubQ = useLoad(() => api.get(`/official-reputation/${userId}`), [userId], { skip: isSelf });

  const profile = isSelf ? q.data : pubQ.data;
  const loading = isSelf ? (!q.data && !q.error) : (!pubQ.data && !pubQ.error);
  const reload = isSelf ? q.reload : pubQ.reload;

  if (loading) return <Loading />;

  const tabs = [
    { value: 'hub', label: t('reputation.tab.hub') },
    ...(isSelf ? [{ value: 'testimony', label: t('reputation.tab.testimony') }] : []),
    { value: 'card', label: t('reputation.tab.card') },
    { value: 'badge', label: t('reputation.tab.badge') },
  ];

  const body = tab === 'hub' ? (profile ? <HubTab profile={profile} reload={reload} /> : <Empty label={t('reputation.empty.no_profile')} />)
    : tab === 'testimony' ? (profile ? <TestimonyTab profile={profile} reload={reload} /> : <Loading />)
    : tab === 'card' ? <PublicCardTab userId={userId} />
    : <BadgeTab userId={userId} />;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ marginBottom: 12 }}>
        <Seg options={tabs} value={tab} onChange={setTab} />
      </View>
      {body}
    </View>
  );
}
