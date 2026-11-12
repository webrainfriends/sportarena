// Official Discounts & Promotions hub (#1017 / R36). Referee's hub for all discount offers:
// recurring contract, event, bulk games, early commitment, loyalty, first booking and coupon types.
// Funded-by attribution (referee/platform/org) is shown on every card.
import React, { useState, useCallback } from 'react';
import { View, TouchableOpacity, FlatList } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, GradCard, H1, Loading, Screen, T, Tag } from '../ui';
import { c, grad, money } from '../theme';
import { Metric } from '../federation-ui';
import { t } from '../i18n';

const STATUS_COLOR = {
  draft: c.sunSoft, active: c.mintSoft, paused: c.sunSoft,
  expired: c.paper, cancelled: c.paper, scheduled: c.cyanSoft,
};
const STATUS_TEXT = {
  draft: c.sun, active: c.mint, paused: c.sun,
  expired: c.mute, cancelled: c.mute, scheduled: c.cyan,
};
const FUNDED_COLOR = {
  referee: c.pinkSoft, platform: c.cyanSoft, organisation: c.limeSoft,
};
const FUNDED_TEXT = {
  referee: c.pink, platform: c.cyan, organisation: c.lime,
};
const TYPE_ICON = {
  recurring_contract: '🔄', event: '📅', bulk_games: '🎯',
  early_commitment: '⚡', loyalty: '⭐', first_booking: '🎁',
  coupon: '🏷️', referral: '👥',
};

function discountValueLabel(d) {
  if (d.kind === 'percent') return `${(d.value_bp / 100).toFixed(0)}% off`;
  if (d.kind === 'fixed' && d.value_minor != null) return `${money(d.value_minor, d.currency)} off`;
  return '—';
}

function statusForDisplay(d) {
  if (d.status === 'active' && d.valid_from && new Date(d.valid_from) > new Date()) return 'scheduled';
  return d.status;
}

function DiscountCard({ d, onPress }) {
  const disp = statusForDisplay(d);
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.82} accessibilityLabel={d.name} accessibilityRole="button">
      <Card style={{ marginBottom: 12, borderRadius: 20, borderWidth: 1.5, borderColor: c.line }}>
        {/* Header row */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
          <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
            <T style={{ fontSize: 22 }}>{TYPE_ICON[d.discount_type] ?? '🏷️'}</T>
          </View>
          <View style={{ flex: 1 }}>
            <T weight='bold' size={15} numberOfLines={1}>{d.name}</T>
            <T size={12} color={c.mute} style={{ marginTop: 2 }}>
              {t(`odisc.type.${d.discount_type}`)} · {discountValueLabel(d)}
            </T>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Tag
              label={t(`odisc.status.${disp}`)}
              color={STATUS_COLOR[disp] ?? c.paper}
              textColor={STATUS_TEXT[disp] ?? c.mute}
            />
          </View>
        </View>

        {/* Funded by + coupon code */}
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          <Chip
            label={t(`odisc.funded_${d.funded_by}`)}
            active={false}
            color={FUNDED_COLOR[d.funded_by]}
            textColor={FUNDED_TEXT[d.funded_by]}
          />
          {d.code && (
            <View style={{ backgroundColor: c.violetSoft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
              <T size={11} weight='bold' color={c.violet} style={{ letterSpacing: 1 }}>{d.code_normalized ?? d.code}</T>
            </View>
          )}
          {d.auto_apply && (
            <View style={{ backgroundColor: c.limeSoft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}>
              <T size={11} color={c.lime}>Auto-apply</T>
            </View>
          )}
        </View>

        {/* Description */}
        {d.description ? (
          <T size={13} color={c.mute} numberOfLines={2} style={{ marginBottom: 8 }}>{d.description}</T>
        ) : null}

        {/* Validity / limits row */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.line }}>
          {d.valid_to ? (
            <T size={11} color={c.mute}>{t('odisc.valid_until', { date: new Date(d.valid_to).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) })}</T>
          ) : (
            <T size={11} color={c.mute}>{t('odisc.valid_always')}</T>
          )}
          {d.max_redemptions != null ? (
            <T size={11} color={c.mute}>{t('odisc.limit_of', { n: d.redemption_count ?? 0, max: d.max_redemptions })}</T>
          ) : (
            <T size={11} color={c.mute}>{t('odisc.unlimited')}</T>
          )}
          {d.per_customer_limit != null && (
            <T size={11} color={c.mute}>{t('odisc.per_customer', { n: d.per_customer_limit })}</T>
          )}
        </View>
      </Card>
    </TouchableOpacity>
  );
}

const FILTERS = ['all', 'active', 'scheduled', 'expired', 'coupon'];

export function OfficialDiscounts() {
  const nav = useNav();
  const [filter, setFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);

  const { data: raw, reload, loading } = useLoad(() => api.get('/official-discounts?limit=100'));

  const items = (raw?.items ?? raw ?? []).filter(d => {
    if (filter === 'all') return !d.archived_at;
    if (filter === 'active') return d.status === 'active' && !d.archived_at;
    if (filter === 'scheduled') return d.status === 'active' && d.valid_from && new Date(d.valid_from) > new Date();
    if (filter === 'expired') return d.status === 'expired' || d.status === 'cancelled';
    if (filter === 'coupon') return d.discount_type === 'coupon' || !!d.code;
    return true;
  });

  const active = (raw?.items ?? raw ?? []).filter(d => d.status === 'active' && !d.archived_at);
  const totalSavings = (raw?.items ?? raw ?? []).reduce((s, d) => s + (d.total_savings_minor ?? 0), 0);
  const totalRedemptions = (raw?.items ?? raw ?? []).reduce((s, d) => s + (d.redemption_count ?? 0), 0);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  if (loading && !raw) return <Loading />;

  return (
    <Screen scroll={false} padBottom>
      {/* Gradient hero */}
      <GradCard colors={grad.hero} style={{ marginHorizontal: 0, borderRadius: 0, paddingTop: 20, paddingBottom: 20 }}>
        <T weight='black' size={24} color='#fff'>{t('odisc.title')}</T>
        <T size={13} color='rgba(255,255,255,0.75)' style={{ marginBottom: 16 }}>{t('odisc.subtitle')}</T>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Metric value={String(active.length)} label={t('odisc.status.active')} tone={c.pinkSoft} />
          <Metric value={totalSavings > 0 ? money(totalSavings, 'GBP') : '—'} label="Savings given" tone={c.mintSoft} />
          <Metric value={String(totalRedemptions)} label="Redemptions" tone={c.cyanSoft} />
        </View>
      </GradCard>

      {/* Filter chips */}
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 12, flexWrap: 'nowrap', overflow: 'scroll' }}>
        {FILTERS.map(f => (
          <TouchableOpacity
            key={f}
            onPress={() => setFilter(f)}
            accessibilityRole="tab"
            accessibilityState={{ selected: filter === f }}
            style={{
              paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
              backgroundColor: filter === f ? c.pink : c.paper,
              borderWidth: 1.5, borderColor: filter === f ? c.pink : c.line,
              minHeight: 36,
            }}
          >
            <T size={13} weight='bold' color={filter === f ? '#fff' : c.ink} style={{ textTransform: 'capitalize' }}>
              {f === 'all' ? 'All' : t(`odisc.status.${f}`) === `odisc.status.${f}` ? f.charAt(0).toUpperCase() + f.slice(1) : t(`odisc.status.${f}`)}
            </T>
          </TouchableOpacity>
        ))}
      </View>

      {/* List */}
      <FlatList
        data={items}
        keyExtractor={d => d.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 100 }}
        refreshing={refreshing}
        onRefresh={onRefresh}
        renderItem={({ item }) => (
          <DiscountCard
            d={item}
            onPress={() => nav.push('OfficialDiscountDetail', { id: item.id })}
          />
        )}
        ListEmptyComponent={
          <Empty
            emoji="🏷️"
            title={t('odisc.empty')}
            sub={t('odisc.empty_sub')}
          />
        }
      />

      {/* FAB */}
      <TouchableOpacity
        onPress={() => nav.push('OfficialDiscountForm', {})}
        accessibilityLabel={t('odisc.create')}
        accessibilityRole="button"
        style={{
          position: 'absolute', bottom: 28, insetInlineEnd: 20,
          width: 56, height: 56, borderRadius: 28,
          backgroundColor: c.pink,
          alignItems: 'center', justifyContent: 'center',
          shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.22, shadowRadius: 8, elevation: 8,
        }}
      >
        <T color='#fff' size={28} weight='bold'>+</T>
      </TouchableOpacity>
    </Screen>
  );
}
