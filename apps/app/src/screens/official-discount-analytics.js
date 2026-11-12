// Promotion analytics screen (#1017 / R36). Shows redemption stats, monthly bar chart,
// top customers and funding breakdown for a single discount offer.
import React, { useCallback, useState } from 'react';
import { View, TouchableOpacity, ScrollView, useWindowDimensions } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Card, Loading, Screen, T } from '../ui';
import { c, grad } from '../theme';
import { money, Metric } from '../federation-ui';
import { t } from '../i18n';

function BarChart({ data = [], currency = 'GBP' }) {
  const max = Math.max(...data.map(d => d.count), 1);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 100, paddingBottom: 20 }}>
      {data.map((d, i) => (
        <View key={i} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
          <View
            style={{
              width: '100%', borderRadius: 6,
              height: Math.max(6, Math.round((d.count / max) * 72)),
              backgroundColor: c.pink,
              opacity: d.count > 0 ? 1 : 0.2,
            }}
          />
          <T size={9} color={c.mute} style={{ position: 'absolute', bottom: 0 }} numberOfLines={1}>{d.month}</T>
        </View>
      ))}
    </View>
  );
}

function FundingBar({ refereeMinor, platformMinor, orgMinor, currency }) {
  const total = refereeMinor + platformMinor + orgMinor;
  if (total === 0) return <T size={13} color={c.mute}>No redemptions yet</T>;
  const refPct = Math.round(refereeMinor / total * 100);
  const platPct = Math.round(platformMinor / total * 100);
  const orgPct = 100 - refPct - platPct;
  return (
    <View>
      <View style={{ flexDirection: 'row', height: 14, borderRadius: 7, overflow: 'hidden', marginBottom: 10 }}>
        {refPct > 0 && <View style={{ flex: refPct, backgroundColor: c.pink }} />}
        {platPct > 0 && <View style={{ flex: platPct, backgroundColor: c.cyan }} />}
        {orgPct > 0 && <View style={{ flex: orgPct, backgroundColor: c.lime }} />}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {refPct > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.pink }} />
            <T size={12} color={c.mute}>{t('odisc.funded_referee')} {refPct}% · {money(refereeMinor, currency)}</T>
          </View>
        )}
        {platPct > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.cyan }} />
            <T size={12} color={c.mute}>{t('odisc.funded_platform')} {platPct}% · {money(platformMinor, currency)}</T>
          </View>
        )}
        {orgPct > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.lime }} />
            <T size={12} color={c.mute}>{t('odisc.funded_org')} {orgPct}% · {money(orgMinor, currency)}</T>
          </View>
        )}
      </View>
    </View>
  );
}

export function OfficialDiscountAnalytics({ route }) {
  const nav = useNav();
  const { id, name } = route?.params ?? {};
  const [refreshing, setRefreshing] = useState(false);

  const { data, reload, loading } = useLoad(() => api.get(`/official-discounts/${id}/analytics`), [id]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  if (loading && !data) return <Loading />;

  const currency = data?.currency ?? 'GBP';
  const totalRedemptions = data?.total_redemptions ?? 0;
  const totalSavings = data?.total_savings_minor ?? 0;
  const thisMonth = data?.redemptions_this_month ?? 0;
  const avgSaving = totalRedemptions > 0 ? Math.round(totalSavings / totalRedemptions) : 0;
  const byMonth = data?.redemptions_by_month ?? [];
  const topCustomers = data?.top_customers ?? [];
  const fundedByBreakdown = data?.funded_by_breakdown ?? { referee: 0, platform: 0, organisation: 0 };

  return (
    <Screen>
      {/* Nav bar */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 10 }}>
        <TouchableOpacity onPress={() => nav.goBack()} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="Back" accessibilityRole="button">
          <T size={20} color={c.pink}>‹</T>
        </TouchableOpacity>
        <T weight='black' size={16} style={{ flex: 1 }} numberOfLines={1}>{t('odisc.analytics.title')}: {name}</T>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}>

        {/* Key metrics strip */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 }}>
          <Metric value={String(totalRedemptions)} label={t('odisc.analytics.total_redemptions')} tone={c.pinkSoft} />
          <Metric value={totalSavings > 0 ? money(totalSavings, currency) : '—'} label={t('odisc.analytics.total_savings')} tone={c.mintSoft} />
          <Metric value={String(thisMonth)} label={t('odisc.analytics.this_month')} tone={c.cyanSoft} />
          <Metric value={avgSaving > 0 ? money(avgSaving, currency) : '—'} label={t('odisc.analytics.avg_saving')} tone={c.sunSoft} />
        </View>

        {/* Redemptions by month */}
        <Card style={{ marginBottom: 16, borderRadius: 18 }}>
          <T weight='bold' size={14} style={{ marginBottom: 12 }}>{t('odisc.analytics.by_month')}</T>
          {byMonth.length > 0 ? (
            <BarChart data={byMonth} currency={currency} />
          ) : (
            <T size={13} color={c.mute}>No redemption data yet</T>
          )}
        </Card>

        {/* Funding breakdown */}
        <Card style={{ marginBottom: 16, borderRadius: 18 }}>
          <T weight='bold' size={14} style={{ marginBottom: 12 }}>{t('odisc.analytics.funded_breakdown')}</T>
          <FundingBar
            refereeMinor={fundedByBreakdown.referee ?? 0}
            platformMinor={fundedByBreakdown.platform ?? 0}
            orgMinor={fundedByBreakdown.organisation ?? 0}
            currency={currency}
          />
        </Card>

        {/* Top customers */}
        <Card style={{ marginBottom: 16, borderRadius: 18 }}>
          <T weight='bold' size={14} style={{ marginBottom: 12 }}>{t('odisc.analytics.top_customers')}</T>
          {topCustomers.length > 0 ? (
            topCustomers.map((cust, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: c.line }}>
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
                  <T weight='bold' color={c.pink}>{i + 1}</T>
                </View>
                <View style={{ flex: 1 }}>
                  <T weight='bold' size={14}>{cust.name}</T>
                  <T size={12} color={c.mute}>{cust.redemption_count} {cust.redemption_count === 1 ? 'redemption' : 'redemptions'}</T>
                </View>
                <T weight='bold' size={14} color={c.pink}>{money(cust.total_saving_minor ?? 0, currency)}</T>
              </View>
            ))
          ) : (
            <T size={13} color={c.mute}>No redemptions yet</T>
          )}
        </Card>

      </ScrollView>
    </Screen>
  );
}
