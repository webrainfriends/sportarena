// Discipline cases screen (#998 / #479). Shows all governance cases visible to the caller:
// cases opened from their submitted reports, cases where they are subject or guardian, and
// event-organiser cases. Each case links back to the originating official report and shows
// provisional sanctions, hearing dates, and available actions.
// No second case store: reads directly from the existing gov_cases + disc_sanctions tables
// via the list_my_discipline_cases and list_governance_cases capabilities.
import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, GradCard, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { LoadError, explain } from '../access';
import { c, grad } from '../theme';
import { t } from '../i18n';
import { Banner, Metric } from '../federation-ui';

const KIND_LABEL = {
  discipline:          t('disc.kind.discipline'),
  appeal:              t('disc.kind.appeal'),
  protest:             t('disc.kind.protest'),
  eligibility_dispute: t('disc.kind.eligibility'),
  licence_issue:       t('disc.kind.licence'),
  waiver:              t('disc.kind.waiver'),
};
const STATUS_CHIP = {
  pending_review: [t('disc.status.pending_review'), c.sunSoft, c.sun],
  open:           [t('disc.status.open'),           c.pinkSoft, c.pink],
  hearing:        [t('disc.status.hearing'),        c.orangeSoft, c.orange],
  closed:         [t('disc.status.closed'),         c.mintSoft, c.mint],
  withdrawn:      [t('disc.status.withdrawn'),      c.violetSoft, c.mute],
  dismissed:      [t('disc.status.dismissed'),      c.violetSoft, c.mute],
};
const CAT_EMOJI = {
  violent_conduct: '🟥', misconduct: '⚠️', caution: '🟨', caution_accumulation: '🟨🟨',
  abandonment: '🚫', protest: '🤝', venue_incident: '🏟️', send_off: '🟥',
  eligibility: '📋', licence: '🪪', waiver: '🤝', other: '📄',
};
const when = (iso) => iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const dateOnly = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

function StatusTag({ status }) {
  const [label, bg, col] = STATUS_CHIP[status] ?? [status, c.violetSoft, c.mute];
  return <Tag label={label} color={bg} style={{ color: col }} />;
}

function CaseCard({ k, onView, onViewReport }) {
  const sanctions = k.live_sanctions > 0;
  const catEmoji = CAT_EMOJI[k.category] ?? '📋';
  return (
    <Card onPress={onView} accessibilityLabel={`${KIND_LABEL[k.kind] ?? k.kind} case ${k.id.slice(0, 8)}, ${k.category}, ${k.status}`}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <StatusTag status={k.status} />
          {k.auto ? <Tag label={t('disc.auto_triggered')} color={c.cyanSoft} /> : null}
          {sanctions ? <Tag label={`⚖️ ${k.live_sanctions} ${t('disc.active_sanctions')}`} color={c.redSoft} /> : null}
          {k.needs_review ? <Tag label={t('disc.needs_review')} color={c.sunSoft} /> : null}
        </View>
        <T weight="800" size={16}>{catEmoji} {KIND_LABEL[k.kind] ?? k.kind} · {k.category?.replace(/_/g, ' ')}</T>
        {k.subject_name ? <T size={14} weight="700">{k.subject_name}{k.subject_team ? <T size={13} color={c.mute}> · {k.subject_team}</T> : null}</T> : null}
        {k.home_name ? <T size={13} color={c.mute}>{k.home_name} v {k.away_name} · {when(k.fixture_at)}</T> : null}
        {k.competition_name ? <T size={12} color={c.mute}>{k.sport_emoji} {k.competition_name}</T> : null}
        {k.appeal_deadline ? <T size={12} color={c.sun}>⏰ {t('disc.appeal_deadline')}: {dateOnly(k.appeal_deadline)}</T> : null}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
          <Btn small title={t('disc.view_case')} onPress={onView} style={{ minHeight: 44 }} />
          {k.linked_report_id ? <Btn small title={t('disc.view_report')} color={c.pinkSoft} onPress={onViewReport} style={{ minHeight: 44 }} /> : null}
        </View>
      </View>
    </Card>
  );
}

function Stats({ items }) {
  const open = items.filter((k) => ['open', 'pending_review', 'hearing'].includes(k.status)).length;
  const hearing = items.filter((k) => k.status === 'hearing').length;
  const sanctions = items.reduce((s, k) => s + (k.live_sanctions ?? 0), 0);
  const appeals = items.filter((k) => k.kind === 'appeal').length;
  const protests = items.filter((k) => k.kind === 'protest').length;
  return (
    <View style={{ flexDirection: 'row', gap: 8, padding: 12, flexWrap: 'nowrap', overflow: 'scroll' }}>
      <Metric value={open} label={t('disc.m_open')} accent={c.red} />
      <Metric value={hearing} label={t('disc.m_hearing')} accent={c.orange} />
      <Metric value={sanctions} label={t('disc.m_sanctions')} accent={c.pink} />
      <Metric value={appeals} label={t('disc.m_appeals')} accent={c.cyan} />
      <Metric value={protests} label={t('disc.m_protests')} accent={c.violet} />
    </View>
  );
}

export function DisciplineCases({ competitionId, eventId }) {
  const { go } = useNav();
  const [status, setStatus] = useState('all');
  const [kind, setKind] = useState('all');
  const cases = useLoad(() => api.get('/discipline/my-cases', { kind, status, limit: 50, offset: 0 }), [kind, status]);

  if (cases.error) return <LoadError error={cases.error} retry={cases.reload} />;
  const items = cases.data?.items ?? [];

  return (
    <Screen onRefresh={cases.reload} refreshing={cases.loading}>
      <GradCard grad={grad.hero} style={{ margin: 16, marginBottom: 0 }}>
        <T size={12} weight="700" color="rgba(255,255,255,.8)" style={{ marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.8 }}>{t('disc.screen_label')}</T>
        <T size={26} weight="800" color="#fff" style={{ letterSpacing: -0.5, lineHeight: 30 }}>{t('disc.screen_title')}</T>
        <T size={13} color="rgba(255,255,255,.85)" style={{ marginTop: 4 }}>{t('disc.screen_sub')}</T>
      </GradCard>

      {items.length > 0 ? <Stats items={items} /> : null}

      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingVertical: 10, flexWrap: 'wrap' }}>
        {[['all', t('disc.filter_all')], ['discipline', t('disc.kind.discipline')], ['appeal', t('disc.kind.appeal')], ['protest', t('disc.kind.protest')]].map(([v, l]) => (
          <Pressable key={v} onPress={() => setKind(v)} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: kind === v ? c.pink : c.paper, minHeight: 44, justifyContent: 'center' }} accessibilityRole="button">
            <T size={13} weight="700" color={kind === v ? '#fff' : c.mute}>{l}</T>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingBottom: 6, flexWrap: 'wrap' }}>
        {[['all', t('disc.filter_all_status')], ['pending_review', t('disc.status.pending_review')], ['open', t('disc.status.open')], ['hearing', t('disc.status.hearing')], ['closed', t('disc.status.closed')]].map(([v, l]) => (
          <Pressable key={v} onPress={() => setStatus(v)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: status === v ? c.violet : c.violetSoft, minHeight: 44, justifyContent: 'center' }} accessibilityRole="button">
            <T size={12} weight="700" color={status === v ? '#fff' : c.mute}>{l}</T>
          </Pressable>
        ))}
      </View>

      {cases.loading && !cases.data ? <Loading /> : null}

      {!cases.loading && items.length === 0 ? (
        <Empty emoji="⚖️" title={t('disc.empty_title')} subtitle={t('disc.empty_sub')} />
      ) : (
        <View style={{ gap: 0, marginTop: 4 }}>
          {items.map((k) => (
            <CaseCard
              key={k.id}
              k={k}
              onView={() => go('GovernanceCase', { id: k.id })}
              onViewReport={k.linked_report_id ? () => go('OfficialReportDetail', { id: k.linked_report_id }) : undefined}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}
