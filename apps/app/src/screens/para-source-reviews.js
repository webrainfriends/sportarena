// PS-29: Platform admin source verification queue for para-sport regional governance and local programmes.
// Shows pending, verified, flagged and rejected claims; each has an action to verify, flag outdated or reject.
// Hidden for every non-platform-admin role.
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Card, Empty, ErrorBox, Loading, Seg, T, Tag } from '../ui';
import { c } from '../theme';
import { t } from '../i18n';

const REVIEW_TABS = [
  ['pending', 'psr.pending'],
  ['sourced', 'psr.verification_status_sourced'],
  ['verified', 'psr.verified_tab'],
  ['flagged', 'psr.flagged_tab'],
  ['rejected', 'psr.rejected_tab'],
];

const STATUS_TONE = {
  pending:  c.sunSoft,
  sourced:  c.cyanSoft,
  verified: c.limeSoft,
  flagged:  c.orangeSoft,
  rejected: c.redSoft,
};

function GovernanceReviewCard({ item, onDone }) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const act = async (status) => {
    setBusy(true);
    try {
      await api.post(`/para/regional-governance/${item.id}/review`, { review_status: status });
      toast(t('psr.verify_source'));
      onDone?.();
    } finally { setBusy(false); }
  };
  return (
    <Card pad={14} style={{ gap: 8 }} accessibilityLabel={`${item.sport_id} ${item.country_iso}`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="800">{item.sport_id} · {item.country_iso}</T>
          <T size={12} color={c.mute}>{item.governing_body}</T>
        </View>
        <Tag label={item.review_status} color={STATUS_TONE[item.review_status] ?? c.sunSoft} />
      </View>
      {item.source_url ? <T size={12} color={c.cyan}>{item.source_url}</T> : null}
      {item.notes ? <T size={12} color={c.mute}>{item.notes}</T> : null}
      {['pending', 'sourced', 'flagged'].includes(item.review_status) ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
          <Btn small disabled={busy} color={c.limeSoft} ink={c.lime} title={t('psr.verify_source')} onPress={() => act('verified')} accessibilityLabel={t('psr.verify_source')} />
          <Btn small disabled={busy} color={c.sunSoft} ink={c.sun} title={t('psr.flag_outdated')} onPress={() => act('flagged')} accessibilityLabel={t('psr.flag_outdated')} />
          <Btn small disabled={busy} color={c.redSoft} ink={c.red} title={t('psr.reject_claim')} onPress={() => act('rejected')} accessibilityLabel={t('psr.reject_claim')} />
        </View>
      ) : null}
    </Card>
  );
}

function ProgrammeReviewCard({ item, onDone }) {
  const { toast } = useSession();
  const [busy, setBusy] = useState(false);
  const act = async (status) => {
    setBusy(true);
    try {
      await api.post(`/para/local-programmes/${item.id}/review`, { verification_status: status });
      toast(t('psr.verify_source'));
      onDone?.();
    } finally { setBusy(false); }
  };
  return (
    <Card pad={14} style={{ gap: 8 }} accessibilityLabel={`${item.name} ${item.country_iso}`}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="800">{item.name}</T>
          <T size={12} color={c.mute}>{item.issuing_body} · {item.country_iso}</T>
        </View>
        <Tag label={item.verification_status} color={STATUS_TONE[item.verification_status] ?? c.sunSoft} />
      </View>
      {item.source_url ? <T size={12} color={c.cyan}>{item.source_url}</T> : null}
      {item.eligibility_rules ? <T size={12} color={c.mute}>{item.eligibility_rules}</T> : null}
      {['unverified', 'sourced'].includes(item.verification_status) ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
          <Btn small disabled={busy} color={c.cyanSoft} ink={c.cyan} title={t('psr.verification_status_sourced')} onPress={() => act('sourced')} accessibilityLabel={t('psr.verification_status_sourced')} />
          <Btn small disabled={busy} color={c.limeSoft} ink={c.lime} title={t('psr.verify_source')} onPress={() => act('verified')} accessibilityLabel={t('psr.verify_source')} />
        </View>
      ) : null}
    </Card>
  );
}

export function ParaSourceReviews() {
  const { user } = useSession();
  const [tab, setTab] = useState('pending');
  const [rev, setRev] = useState(0);

  const allowed = user?.roles?.includes('platform_admin');

  const govItems = useLoad(
    () => (allowed ? api.get('/para/regional-governance', { review_status: tab === 'pending' ? 'pending' : tab, limit: 100 }) : Promise.resolve(null)),
    [allowed, tab, rev]);
  const progItems = useLoad(
    () => (allowed ? api.get('/para/local-programmes', { verification_status: tab === 'pending' ? 'unverified' : tab === 'verified' ? 'verified' : tab === 'sourced' ? 'sourced' : null, limit: 100 }) : Promise.resolve(null)),
    [allowed, tab, rev]);

  if (!allowed) {
    return <Empty emoji="🔒" title={t('psr.source_review_title')} sub="Platform admin only." />;
  }

  const govList = govItems.data?.governance ?? [];
  const progList = (progItems.data?.programmes ?? []).filter((p) => {
    if (tab === 'pending') return p.verification_status === 'unverified';
    if (tab === 'sourced') return p.verification_status === 'sourced';
    if (tab === 'verified') return p.verification_status === 'verified';
    return false;
  });
  const done = () => setRev((n) => n + 1);

  return (
    <View style={{ gap: 14 }}>
      <T size={20} weight="800" accessibilityRole="header">{t('psr.source_review_title')}</T>
      <T size={13} color={c.mute}>{t('psr.source_review_subtitle')}</T>
      <Seg
        options={REVIEW_TABS.map(([v, lk]) => ({ value: v, label: t(lk) }))}
        value={tab}
        onChange={setTab}
      />
      {govItems.error ? <ErrorBox error={govItems.error} onRetry={govItems.reload} /> : null}
      {progItems.error ? <ErrorBox error={progItems.error} onRetry={progItems.reload} /> : null}
      {(!govItems.data && !govItems.error) ? <Loading /> : null}

      {govList.length > 0 ? (
        <View style={{ gap: 8 }}>
          <T size={12} weight="800" color={c.mute}>{t('psr.federation_connections').toUpperCase()}</T>
          {govList.map((item) => <GovernanceReviewCard key={item.id} item={item} onDone={done} />)}
        </View>
      ) : null}

      {progList.length > 0 ? (
        <View style={{ gap: 8 }}>
          <T size={12} weight="800" color={c.mute}>{t('psr.local_programmes').toUpperCase()}</T>
          {progList.map((item) => <ProgrammeReviewCard key={item.id} item={item} onDone={done} />)}
        </View>
      ) : null}

      {govList.length === 0 && progList.length === 0 && govItems.data ? (
        <Empty emoji="✓" title={t('psr.verified_tab')} sub={`No ${tab} items.`} />
      ) : null}
    </View>
  );
}
