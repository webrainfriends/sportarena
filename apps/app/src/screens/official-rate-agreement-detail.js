// Agreement detail screen (Issue #1016 / R35). Both parties see this. Shows full terms, rate breakdown,
// tier table, approval timeline and version history. Accept / Counter / Cancel actions inline.
import React, { useState } from 'react';
import { View, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Loading, Screen, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { Field } from '../ui';
import { c, grad } from '../theme';
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
const TL_STATUS = {
  created: { icon: '✏️', label: t('ora.tl_created') },
  proposed: { icon: '📤', label: t('ora.tl_proposed') },
  countered: { icon: '🔄', label: t('ora.tl_countered') },
  accepted: { icon: '✅', label: t('ora.tl_accepted') },
  cancelled: { icon: '✕', label: t('ora.tl_cancelled') },
  superseded: { icon: '🔁', label: t('ora.tl_superseded') },
  note_added: { icon: '💬', label: t('ora.tl_note') },
};

function InfoRow({ label, value, highlight }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <T size={13} color={c.mute} weight='semibold'>{label}</T>
      <T size={13} weight='bold' color={highlight ? c.pink : c.ink} style={{ maxWidth: 220, textAlign: 'right' }}>{value ?? '—'}</T>
    </View>
  );
}

function TierTable({ tiers, currency }) {
  return (
    <View style={{ borderRadius: 16, borderWidth: 1.5, borderColor: c.line, overflow: 'hidden', marginBottom: 12 }}>
      <View style={{ flexDirection: 'row', backgroundColor: c.violetSoft, padding: 10 }}>
        {[t('ora.tier_range'), t('ora.tier_fee'), t('ora.tier_travel')].map(h => (
          <T key={h} size={11} weight='bold' color={c.violet} style={{ flex: 1 }}>{h}</T>
        ))}
      </View>
      {tiers.map(tier => (
        <View key={tier.tier_order} style={{ flexDirection: 'row', padding: 12, borderTopWidth: 1, borderTopColor: c.line }}>
          <T size={13} weight='bold' color={c.ink} style={{ flex: 1 }}>
            {tier.games_to ? `${tier.games_from}–${tier.games_to}` : `${tier.games_from}+`}
          </T>
          <T size={13} weight='bold' color={c.pink} style={{ flex: 1 }}>{money(tier.fee_minor, currency)}</T>
          <T size={12} color={c.mute} style={{ flex: 1 }}>{tier.travel_minor ? money(tier.travel_minor, currency) : '—'}</T>
        </View>
      ))}
    </View>
  );
}

export function OfficialRateAgreementDetail({ route }) {
  const { id, mode } = route?.params ?? {};
  const nav = useNav();
  const { user } = useSession();
  const [counterSheet, setCounterSheet] = useState(false);
  const [counterNote, setCounterNote] = useState('');
  const [cancelSheet, setCancelSheet] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: a, reload, loading } = useLoad(() => api('GET', `/rate-agreements/${id}`));

  if (loading || !a) return <Loading />;

  const isOfficial = a.official_id === user?.id;
  const canAct = ['proposed', 'countered'].includes(a.status);

  async function doAccept() {
    setBusy(true);
    await api('POST', `/rate-agreements/${id}/accept`, { body: {} });
    setBusy(false);
    reload();
  }
  async function doCancel() {
    if (!cancelReason.trim()) return;
    setBusy(true);
    await api('POST', `/rate-agreements/${id}/cancel`, { body: { reason: cancelReason } });
    setBusy(false);
    setCancelSheet(false);
    reload();
  }
  async function doCounter() {
    nav.push('OfficialRateAgreementWizard', { existingId: id, mode: 'counter', note: counterNote });
    setCounterSheet(false);
  }

  const tiers = a.tiers ?? [];
  const versions = a.versions ?? [];

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 160 }}>
        {/* Hero */}
        <View style={{ background: undefined, padding: 20, paddingTop: 16, ...grad('135deg', c.pink, c.violet), marginBottom: 0 }}>
          <TouchableOpacity onPress={() => nav.goBack()} style={{ marginBottom: 8 }}>
            <T color='rgba(255,255,255,0.7)' size={13}>← {t('ora.back')}</T>
          </TouchableOpacity>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <View style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' }}>
              <T style={{ fontSize: 24 }}>{a.sport_emoji ?? '📄'}</T>
            </View>
            <View>
              <T size={12} color='rgba(255,255,255,0.7)'>{isOfficial ? t('ora.counterpart') : t('ora.official')}</T>
              <T size={20} weight='bold' color='white'>{isOfficial ? (a.org_name ?? a.counterpart_name) : a.official_name}</T>
              <T size={13} color='rgba(255,255,255,0.8)'>{a.sport_name} · {a.official_role}</T>
            </View>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <View style={{ backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20 }}>
              <T size={12} weight='bold' color='white'>{CONTEXT_LABEL[a.context_type]}</T>
            </View>
            <View style={{ backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20 }}>
              <T size={12} weight='bold' color='white'>{RATE_LABEL[a.rate_type]}</T>
            </View>
            <View style={{ backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20 }}>
              <T size={12} weight='bold' color='white'>{a.status.toUpperCase()}</T>
            </View>
          </View>
        </View>

        <View style={{ padding: 16 }}>
          {/* Rate breakdown */}
          <T size={12} weight='bold' color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 16, marginBottom: 8 }}>{t('ora.rate_summary')}</T>

          {tiers.length > 0 ? <TierTable tiers={tiers} currency={a.currency} /> : null}

          {a.base_fee_minor != null && a.rate_type !== 'volume_tiers' && (
            <InfoRow label={t('ora.base_fee')} value={money(a.base_fee_minor, a.currency)} />
          )}
          {a.retainer_minor != null && (
            <InfoRow label={t('ora.retainer')} value={`${money(a.retainer_minor, a.currency)} / ${t('ora.month')}`} />
          )}
          {a.travel_minor != null && <InfoRow label={t('ora.travel')} value={`${money(a.travel_minor, a.currency)} / ${t('ora.game')}`} />}
          {a.overtime_minor != null && <InfoRow label={t('ora.overtime')} value={`${money(a.overtime_minor, a.currency)} / h`} />}
          {a.accom_minor != null && <InfoRow label={t('ora.accommodation')} value={`${money(a.accom_minor, a.currency)} / ${t('ora.night')}`} />}
          {a.bundle_minor != null && a.rate_type === 'bundle' && (
            <InfoRow label={t('ora.bundle_fee')} value={money(a.bundle_minor, a.currency)} />
          )}
          {a.bundle_desc && <InfoRow label={t('ora.bundle_includes')} value={a.bundle_desc} />}

          <T size={12} weight='bold' color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 20, marginBottom: 8 }}>{t('ora.validity')}</T>
          <InfoRow label={t('ora.effective_from')} value={a.effective_from} />
          {a.effective_until && <InfoRow label={t('ora.effective_until')} value={a.effective_until} />}
          {a.auto_renew && a.auto_renew !== 'none' && <InfoRow label={t('ora.auto_renew')} value={a.auto_renew.replace('_', ' ')} />}

          {(a.notice_days || a.cancel_fee_pct) && <>
            <T size={12} weight='bold' color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 20, marginBottom: 8 }}>{t('ora.cancellation')}</T>
            {a.notice_days && <InfoRow label={t('ora.notice')} value={`${a.notice_days} ${t('ora.days')}`} />}
            {a.cancel_fee_pct && <InfoRow label={t('ora.cancel_fee')} value={`${a.cancel_fee_pct}%`} />}
          </>}

          {(a.payment_trigger || a.payment_net_days) && <>
            <T size={12} weight='bold' color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 20, marginBottom: 8 }}>{t('ora.payment_terms')}</T>
            {a.payment_trigger && <InfoRow label={t('ora.invoice_trigger')} value={a.payment_trigger.replace(/_/g, ' ')} />}
            {a.payment_net_days && <InfoRow label={t('ora.payment_net')} value={`Net ${a.payment_net_days}`} />}
          </>}

          {/* Immutable snapshot notice */}
          {['active', 'accepted'].includes(a.status) && (
            <View style={{ backgroundColor: c.mintSoft, borderRadius: 12, padding: 12, flexDirection: 'row', gap: 8, marginTop: 16, borderWidth: 1, borderColor: c.mint + '40' }}>
              <T size={16}>🔒</T>
              <T size={12} color='#1A6B56' weight='semibold' style={{ flex: 1, lineHeight: 18 }}>{t('ora.snapshot_notice')}</T>
            </View>
          )}

          {/* Timeline */}
          {versions.length > 0 && <>
            <T size={12} weight='bold' color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 24, marginBottom: 12 }}>{t('ora.timeline')}</T>
            {versions.map((v, idx) => {
              const tl = TL_STATUS[v.event_kind] ?? { icon: '●', label: v.event_kind };
              const isLast = idx === versions.length - 1;
              return (
                <View key={v.id} style={{ flexDirection: 'row', gap: 12, paddingBottom: isLast ? 0 : 16 }}>
                  <View style={{ alignItems: 'center' }}>
                    <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.mintSoft, borderWidth: 2, borderColor: c.mint, alignItems: 'center', justifyContent: 'center' }}>
                      <T size={14}>{tl.icon}</T>
                    </View>
                    {!isLast && <View style={{ width: 2, flex: 1, backgroundColor: c.line, marginTop: 4 }} />}
                  </View>
                  <View style={{ flex: 1, paddingTop: 4 }}>
                    <T size={13} weight='bold' color={c.ink}>{tl.label}</T>
                    <T size={11} color={c.mute} style={{ marginTop: 2 }}>{v.actor_name} · {new Date(v.created_at).toLocaleString()}</T>
                    {v.note && <T size={12} color={c.mute} style={{ marginTop: 4, fontStyle: 'italic' }}>{v.note}</T>}
                  </View>
                </View>
              );
            })}
          </>}
        </View>
      </ScrollView>

      {/* Action bar */}
      {canAct && (
        <View style={{ position: 'absolute', bottom: 80, left: 0, right: 0, flexDirection: 'row', gap: 10, padding: 16, backgroundColor: c.paper, borderTopWidth: 1, borderTopColor: c.line }}>
          <Btn
            label={t('ora.decline')} onPress={() => setCancelSheet(true)}
            style={{ flex: 1, backgroundColor: c.redSoft, borderWidth: 0 }} textColor={c.red}
          />
          <Btn
            label={t('ora.counter')} onPress={() => setCounterSheet(true)}
            style={{ flex: 1, backgroundColor: c.card, borderWidth: 1.5, borderColor: c.line }} textColor={c.ink}
          />
          <Btn
            label={t('ora.accept')} onPress={doAccept} busy={busy}
            style={{ flex: 2, backgroundColor: c.mint }} textColor='white'
          />
        </View>
      )}
      {['active', 'accepted'].includes(a.status) && (
        <View style={{ position: 'absolute', bottom: 80, left: 0, right: 0, flexDirection: 'row', gap: 10, padding: 16, backgroundColor: c.paper, borderTopWidth: 1, borderTopColor: c.line }}>
          <Btn label={t('ora.cancel_agreement')} onPress={() => setCancelSheet(true)} style={{ flex: 1, backgroundColor: c.redSoft }} textColor={c.red} />
        </View>
      )}

      {/* Counter sheet */}
      <FormSheet visible={counterSheet} onClose={() => setCounterSheet(false)} title={t('ora.counter_title')}>
        <T size={13} color={c.mute} style={{ marginBottom: 12 }}>{t('ora.counter_body')}</T>
        <Field label={t('ora.counter_note')} value={counterNote} onChangeText={setCounterNote} multiline />
        <Btn label={t('ora.counter_proceed')} onPress={doCounter} style={{ marginTop: 16, backgroundColor: c.pink }} textColor='white' />
      </FormSheet>

      {/* Cancel sheet */}
      <FormSheet visible={cancelSheet} onClose={() => setCancelSheet(false)} title={t('ora.cancel_title')}>
        <T size={13} color={c.mute} style={{ marginBottom: 12 }}>{t('ora.cancel_body')}</T>
        <Field label={t('ora.cancel_reason')} value={cancelReason} onChangeText={setCancelReason} multiline required />
        <Btn label={t('ora.confirm_cancel')} onPress={doCancel} busy={busy} style={{ marginTop: 16, backgroundColor: c.red }} textColor='white' />
      </FormSheet>
    </Screen>
  );
}
