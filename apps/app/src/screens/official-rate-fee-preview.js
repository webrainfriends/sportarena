// Rate resolution / fee preview screen (Issue #1016 / R35). Shown before confirming an assignment.
// Displays the resolved fee, the full precedence chain and a per-game breakdown.
import React from 'react';
import { View, ScrollView, TouchableOpacity } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Card, Loading, Screen, T } from '../ui';
import { c } from '../theme';
import { money } from '../federation-ui';
import { t } from '../i18n';

const LEVEL_LABEL = {
  profile_default: t('ora.prec_default'),
  segment: t('ora.prec_segment'),
  customer: t('ora.prec_customer'),
  agreement: t('ora.prec_agreement'),
  booked_snapshot: t('ora.prec_snapshot'),
};

export function OfficialRateFeePreview({ route }) {
  const { official_id, event_id, counterpart_org_id, sport_id, official_role, game_count } = route?.params ?? {};
  const nav = useNav();

  const { data, loading } = useLoad(() =>
    api('GET', `/rate-agreements/preview?official_id=${official_id}${event_id ? `&event_id=${event_id}` : ''}${counterpart_org_id ? `&counterpart_org_id=${counterpart_org_id}` : ''}${sport_id ? `&sport_id=${sport_id}` : ''}&official_role=${official_role ?? 'referee'}&game_count=${game_count ?? 0}`)
  );

  if (loading || !data) return <Loading />;

  const { resolved, total_fee_minor, currency, chain } = data;

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 20, paddingBottom: 8, gap: 10 }}>
        <TouchableOpacity onPress={() => nav.goBack()}>
          <T color={c.mute} size={16}>←</T>
        </TouchableOpacity>
        <T weight='bold' size={20} style={{ flex: 1 }}>{t('ora.fee_preview_title')}</T>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 100 }}>
        {/* Resolution banner */}
        <View style={{ borderRadius: 20, padding: 16, backgroundColor: c.mint, marginBottom: 12 }}>
          <T size={15} weight='bold' color='white'>{t('ora.applicable_fee')}</T>
          <T size={34} weight='bold' color='white' style={{ marginVertical: 8 }}>
            {money(resolved.fee_minor, resolved.currency)}
          </T>
          <T size={12} color='rgba(255,255,255,0.85)'>
            {resolved.level === 'agreement'
              ? `${t('ora.prec_agreement')} · ${resolved.tier_applied ? `${t('ora.tier')} ${resolved.tier_applied}` : ''} · ${game_count ?? 0} ${t('ora.games')}`
              : LEVEL_LABEL[resolved.level]}
          </T>
        </View>

        {/* Precedence chain */}
        <T size={12} weight='bold' color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>{t('ora.precedence')}</T>
        <View style={{ borderRadius: 16, borderWidth: 1.5, borderColor: c.line, overflow: 'hidden', marginBottom: 16 }}>
          {[...chain].reverse().map((item) => (
            <View key={item.rank} style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12, borderBottomWidth: item.rank > 1 ? 1 : 0, borderBottomColor: c.line, backgroundColor: item.active ? c.pinkSoft : undefined }}>
              <View style={{
                width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
                backgroundColor: item.active ? c.pink : c.violetSoft,
              }}>
                <T size={11} weight='bold' color={item.active ? 'white' : c.violet}>{item.rank}</T>
              </View>
              <View style={{ flex: 1 }}>
                <T size={13} weight='bold' color={item.active ? c.ink : c.mute}>{LEVEL_LABEL[item.level]}</T>
                <T size={11} color={c.mute} style={{ marginTop: 2 }}>
                  {item.note ?? (item.agreement_id ? `${t('ora.agreement')} · ${item.tier_applied ? `${t('ora.tier')} ${item.tier_applied}` : ''}` : '')}
                </T>
              </View>
              <T size={14} weight='bold' color={item.active ? c.pink : c.mute}>
                {item.fee_minor != null ? money(item.fee_minor, item.currency ?? resolved.currency) : '—'}
              </T>
              {item.active && <T size={18} color={c.mint}>✓</T>}
            </View>
          ))}
        </View>

        {/* Breakdown */}
        <T size={12} weight='bold' color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>{t('ora.breakdown')}</T>
        <Card style={{ borderRadius: 16, borderWidth: 1.5, borderColor: c.line, padding: 0, overflow: 'hidden' }}>
          {[
            { label: t('ora.base_fee'), value: money(resolved.fee_minor, resolved.currency) },
            { label: t('ora.travel'), value: resolved.travel_minor ? money(resolved.travel_minor, resolved.currency) : `${t('ora.not_included')}` },
            { label: t('ora.overtime'), value: resolved.overtime_minor ? `${money(resolved.overtime_minor, resolved.currency)} / h` : `${t('ora.not_in_agreement')}` },
            { label: t('ora.total_this_game'), value: money(total_fee_minor, resolved.currency), highlight: true },
          ].map(({ label, value, highlight }, idx) => (
            <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', padding: 14, borderTopWidth: idx > 0 ? 1 : 0, borderTopColor: c.line }}>
              <T size={13} color={highlight ? c.ink : c.mute} weight={highlight ? 'bold' : 'semibold'}>{label}</T>
              <T size={highlight ? 15 : 13} weight='bold' color={highlight ? c.pink : c.ink}>{value}</T>
            </View>
          ))}
        </Card>

        {/* Snapshot notice */}
        <View style={{ backgroundColor: c.mintSoft, borderRadius: 12, padding: 12, flexDirection: 'row', gap: 8, marginTop: 16, borderWidth: 1, borderColor: c.mint + '40' }}>
          <T size={16}>📸</T>
          <T size={12} color='#1A6B56' weight='semibold' style={{ flex: 1, lineHeight: 18 }}>
            {t('ora.snapshot_on_confirm', { fee: money(total_fee_minor, resolved.currency) })}
          </T>
        </View>
      </ScrollView>
    </Screen>
  );
}
