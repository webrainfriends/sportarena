// Official Rate Agreements screen (Issue #1016 / R35). The official's hub for all negotiated rate
// arrangements with academies, clubs, events and organisations.
// Three tabs: active agreements, pending (proposals waiting on the caller), history/cancelled.
// Tapping any card opens OfficialRateAgreementDetail. "+" opens OfficialRateAgreementWizard.
import React, { useState } from 'react';
import { View, TouchableOpacity, ScrollView, RefreshControl } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, GradCard, H1, Loading, Screen, Section, Seg, T, Tag } from '../ui';
import { c } from '../theme';
import { Metric } from '../federation-ui';
import { money } from '../federation-ui';
import { t } from '../i18n';

const CONTEXT_LABEL = {
  event_override: t('ora.ctx_event'), academy_contract: t('ora.ctx_academy'),
  season_series: t('ora.ctx_season'), club_org: t('ora.ctx_club'), retainer: t('ora.ctx_retainer'),
};
const RATE_LABEL = {
  fixed_match: t('ora.rt_fixed'), per_hour: t('ora.rt_hour'), per_day: t('ora.rt_day'),
  volume_tiers: t('ora.rt_tiers'), retainer: t('ora.rt_retainer'), bundle: t('ora.rt_bundle'),
  negotiated: t('ora.rt_negotiated'),
};
const STATUS_COLOR = {
  draft: c.sunSoft, proposed: c.violetSoft, countered: c.sunSoft,
  active: c.mintSoft, accepted: c.mintSoft, superseded: c.paper, cancelled: c.paper,
};
const STATUS_TEXT_COLOR = {
  draft: c.sun, proposed: c.violet, countered: c.sun,
  active: c.mint, accepted: c.mint, superseded: c.mute, cancelled: c.mute,
};

function rateSummary(a) {
  if (a.rate_type === 'volume_tiers' && a.tiers?.length) {
    const lo = a.tiers[0];
    const hi = a.tiers[a.tiers.length - 1];
    return `${money(hi.fee_minor, a.currency)} – ${money(lo.fee_minor, a.currency)}`;
  }
  if (a.rate_type === 'retainer') {
    return `${money(a.retainer_minor, a.currency)}/mo + ${money(a.base_fee_minor, a.currency)}`;
  }
  if (a.rate_type === 'bundle') return money(a.bundle_minor, a.currency);
  if (a.base_fee_minor != null) return money(a.base_fee_minor, a.currency);
  return '—';
}

function AgreementCard({ a, onPress }) {
  const tiers = a.tiers ?? [];
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.82}>
      <Card style={{ marginBottom: 12, borderRadius: 20, borderWidth: 1.5, borderColor: c.line }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
          <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}>
            <T style={{ fontSize: 20 }}>{a.sport_emoji ?? '📄'}</T>
          </View>
          <View style={{ flex: 1 }}>
            <T weight='bold' size={15}>{a.org_name ?? a.counterpart_name}</T>
            <T size={12} color={c.mute} style={{ marginTop: 2 }}>
              {CONTEXT_LABEL[a.context_type]} · {a.sport_name ?? t('ora.any_sport')}
            </T>
          </View>
          <Tag
            label={a.status.charAt(0).toUpperCase() + a.status.slice(1)}
            color={STATUS_COLOR[a.status]}
            textColor={STATUS_TEXT_COLOR[a.status]}
          />
        </View>

        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <Chip label={RATE_LABEL[a.rate_type]} color={c.pinkSoft} textColor={c.pink} />
          {a.currency !== 'GBP' && <Chip label={a.currency} color={c.cyanSoft} textColor={c.cyan} />}
        </View>

        {a.rate_type === 'volume_tiers' && tiers.length > 0 ? (
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
            {tiers.slice(0, 3).map((tier) => (
              <View key={tier.tier_order} style={{ flex: 1, backgroundColor: c.paper, borderRadius: 10, padding: 8, alignItems: 'center', borderWidth: 1, borderColor: c.line }}>
                <T weight='bold' size={15} color={c.ink}>{money(tier.fee_minor, a.currency)}</T>
                <T size={10} color={c.mute} style={{ marginTop: 2 }}>
                  {tier.games_to ? `${tier.games_from}–${tier.games_to}` : `${tier.games_from}+`} {t('ora.games')}
                </T>
              </View>
            ))}
          </View>
        ) : (
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
            <View style={{ flex: 1, backgroundColor: c.paper, borderRadius: 10, padding: 8, alignItems: 'center', borderWidth: 1, borderColor: c.line }}>
              <T weight='bold' size={16} color={c.ink}>{rateSummary(a)}</T>
              <T size={10} color={c.mute} style={{ marginTop: 2 }}>{RATE_LABEL[a.rate_type]}</T>
            </View>
            {a.travel_minor > 0 && (
              <View style={{ flex: 1, backgroundColor: c.paper, borderRadius: 10, padding: 8, alignItems: 'center', borderWidth: 1, borderColor: c.line }}>
                <T weight='bold' size={16} color={c.ink}>{money(a.travel_minor, a.currency)}</T>
                <T size={10} color={c.mute} style={{ marginTop: 2 }}>{t('ora.travel')}</T>
              </View>
            )}
          </View>
        )}

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: 8, borderTopWidth: 1, borderTopColor: c.line }}>
          <T size={11} color={c.mute}>
            {a.effective_from}{a.effective_until ? ` – ${a.effective_until}` : ''}
          </T>
          <T size={11} weight='bold' color={c.pink}>{a.official_role}</T>
        </View>
      </Card>
    </TouchableOpacity>
  );
}

function PendingCard({ a, userId, onAccept, onCounter, onDecline, onPress }) {
  const isIncoming = a.proposed_by !== userId && a.official_id === userId || a.proposed_by !== userId;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.82}>
      <Card style={{ marginBottom: 12, borderRadius: 20, borderWidth: 2, borderColor: isIncoming ? c.sun : c.line, backgroundColor: isIncoming ? c.sunSoft : c.card }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
          <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}>
            <T style={{ fontSize: 20 }}>{a.sport_emoji ?? '📄'}</T>
          </View>
          <View style={{ flex: 1 }}>
            <T weight='bold' size={15}>{a.org_name ?? a.counterpart_name}</T>
            <T size={12} color={c.mute} style={{ marginTop: 2 }}>{CONTEXT_LABEL[a.context_type]}</T>
          </View>
          <Chip
            label={isIncoming ? t('ora.review') : t('ora.sent')}
            color={isIncoming ? c.sunSoft : c.violetSoft}
            textColor={isIncoming ? c.sun : c.violet}
          />
        </View>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
          <Chip label={RATE_LABEL[a.rate_type]} color={c.pinkSoft} textColor={c.pink} />
        </View>
        <T weight='bold' size={16} color={c.ink} style={{ marginBottom: 4 }}>{rateSummary(a)}</T>
        {isIncoming && (
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
            <Btn label={t('ora.accept')} onPress={() => onAccept(a)} style={{ flex: 1, backgroundColor: c.mint }} />
            <Btn label={t('ora.counter')} onPress={() => onCounter(a)} style={{ flex: 1, backgroundColor: c.card, borderWidth: 1.5, borderColor: c.line }} textColor={c.ink} />
            <TouchableOpacity onPress={() => onDecline(a)} style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: c.redSoft, alignItems: 'center', justifyContent: 'center' }}>
              <T color={c.red} size={18}>✕</T>
            </TouchableOpacity>
          </View>
        )}
        {!isIncoming && (
          <T size={11} color={c.mute} style={{ marginTop: 4 }}>{t('ora.awaiting_response')}</T>
        )}
      </Card>
    </TouchableOpacity>
  );
}

export function OfficialRateAgreements() {
  const nav = useNav();
  const { user } = useSession();
  const [tab, setTab] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const { data: all, reload, loading } = useLoad(() => api('GET', '/rate-agreements?status=all&limit=100'));

  const active = (all ?? []).filter(a => ['active', 'accepted'].includes(a.status));
  const pending = (all ?? []).filter(a => ['proposed', 'countered', 'draft'].includes(a.status));
  const history = (all ?? []).filter(a => ['cancelled', 'superseded'].includes(a.status));

  // summary metrics
  const avgFee = active.length
    ? active.reduce((s, a) => s + (a.base_fee_minor ?? 0), 0) / active.length / 100
    : 0;

  async function onRefresh() {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }

  async function quickAccept(a) {
    await api('POST', `/rate-agreements/${a.id}/accept`, { body: {} });
    reload();
  }
  async function quickDecline(a) {
    await api('POST', `/rate-agreements/${a.id}/cancel`, { body: { reason: t('ora.declined') } });
    reload();
  }

  const lists = [active, pending, history];
  const currentList = lists[tab];

  if (loading && !all) return <Loading />;

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4, gap: 10 }}>
        <H1 style={{ flex: 1 }}>{t('ora.title')}</H1>
        <TouchableOpacity
          onPress={() => nav.push('OfficialRateAgreementWizard')}
          style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center' }}
        >
          <T color='white' size={22} weight='bold'>+</T>
        </TouchableOpacity>
      </View>

      <View style={{ flexDirection: 'row', paddingHorizontal: 20, gap: 10, marginBottom: 12 }}>
        <Metric label={t('ora.metric_active')} value={active.length} unit={t('ora.metric_active_unit')} />
        <Metric label={t('ora.metric_avg')} value={`£${avgFee.toFixed(0)}`} unit={t('ora.metric_avg_unit')} />
        <Metric label={t('ora.metric_pending')} value={pending.length} unit={t('ora.metric_pending_unit')} color={pending.length > 0 ? c.sunSoft : undefined} />
      </View>

      <Seg
        options={[t('ora.tab_active'), `${t('ora.tab_pending')}${pending.length > 0 ? ` (${pending.length})` : ''}`, t('ora.tab_history')]}
        value={tab}
        onChange={setTab}
        style={{ marginHorizontal: 20, marginBottom: 12 }}
      />

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {currentList.length === 0 && (
          <Empty
            icon='📄'
            title={tab === 0 ? t('ora.empty_active_title') : tab === 1 ? t('ora.empty_pending_title') : t('ora.empty_history_title')}
            body={tab === 0 ? t('ora.empty_active_body') : tab === 1 ? t('ora.empty_pending_body') : t('ora.empty_history_body')}
            action={tab === 0 ? { label: t('ora.new'), onPress: () => nav.push('OfficialRateAgreementWizard') } : undefined}
          />
        )}

        {tab === 1 && pending.some(a => a.proposed_by !== user?.id) && (
          <T size={12} weight='bold' color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>{t('ora.incoming')}</T>
        )}

        {currentList.map(a =>
          tab === 1 ? (
            <PendingCard
              key={a.id} a={a} userId={user?.id}
              onAccept={quickAccept}
              onCounter={() => nav.push('OfficialRateAgreementDetail', { id: a.id, mode: 'counter' })}
              onDecline={quickDecline}
              onPress={() => nav.push('OfficialRateAgreementDetail', { id: a.id })}
            />
          ) : (
            <AgreementCard
              key={a.id} a={a}
              onPress={() => nav.push('OfficialRateAgreementDetail', { id: a.id })}
            />
          )
        )}
      </ScrollView>
    </Screen>
  );
}
