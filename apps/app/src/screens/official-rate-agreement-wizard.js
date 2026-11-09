// 5-step wizard: create or counter a rate agreement (Issue #1016 / R35).
// Step 1: Agreement type (context_type)
// Step 2: Counterpart (org search + pick, sport, role)
// Step 3: Rate structure (rate_type, tiers, currency, travel, overtime)
// Step 4: Validity, renewal, cancellation, payment terms
// Step 5: Review and send / save as draft
import React, { useState, useEffect } from 'react';
import { View, ScrollView, TouchableOpacity } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Btn, Card, Chip, Loading, Screen, T } from '../ui';
import { Field } from '../ui';
import { MenuField, MultiMenuField } from '../FormSheet';
import { DatePicker } from '../pickers';
import { c } from '../theme';
import { money } from '../federation-ui';
import { t } from '../i18n';

const STEPS = 5;

const CONTEXT_OPTIONS = [
  { value: 'event_override', icon: '📅', label: t('ora.ctx_event'), desc: t('ora.ctx_event_desc') },
  { value: 'academy_contract', icon: '🎓', label: t('ora.ctx_academy'), desc: t('ora.ctx_academy_desc') },
  { value: 'season_series', icon: '📆', label: t('ora.ctx_season'), desc: t('ora.ctx_season_desc') },
  { value: 'club_org', icon: '🏟️', label: t('ora.ctx_club'), desc: t('ora.ctx_club_desc') },
  { value: 'retainer', icon: '🔁', label: t('ora.ctx_retainer'), desc: t('ora.ctx_retainer_desc') },
];
const RATE_TYPE_OPTIONS = [
  { value: 'fixed_match', icon: '🎯', label: t('ora.rt_fixed') },
  { value: 'volume_tiers', icon: '📊', label: t('ora.rt_tiers') },
  { value: 'per_hour', icon: '🕐', label: t('ora.rt_hour') },
  { value: 'per_day', icon: '📅', label: t('ora.rt_day') },
  { value: 'retainer', icon: '🔁', label: t('ora.rt_retainer') },
  { value: 'bundle', icon: '📦', label: t('ora.rt_bundle') },
];
const AUTO_RENEW_OPTIONS = [
  { value: 'none', label: t('ora.ar_none') },
  { value: 'notify_30', label: t('ora.ar_30') },
  { value: 'notify_60', label: t('ora.ar_60') },
  { value: 'auto', label: t('ora.ar_auto') },
];
const PAYMENT_TRIGGER_OPTIONS = [
  { value: 'per_game', label: t('ora.pt_per_game') },
  { value: 'weekly', label: t('ora.pt_weekly') },
  { value: 'monthly', label: t('ora.pt_monthly') },
  { value: 'on_completion', label: t('ora.pt_completion') },
];

function StepIndicator({ step }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, marginBottom: 20 }}>
      {Array.from({ length: STEPS }).map((_, i) => (
        <View key={i} style={{
          height: 8, borderRadius: 4,
          width: i === step - 1 ? 24 : 8,
          backgroundColor: i < step - 1 ? c.mint : i === step - 1 ? c.pink : c.line,
        }} />
      ))}
    </View>
  );
}

function ContextCard({ opt, selected, onPress }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.82}>
      <View style={{
        backgroundColor: selected ? c.pinkSoft : c.card,
        borderRadius: 18, padding: 16, marginBottom: 10,
        borderWidth: 2, borderColor: selected ? c.pink : c.line,
        flexDirection: 'row', alignItems: 'center', gap: 14,
      }}>
        <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: selected ? c.pink : c.violetSoft, alignItems: 'center', justifyContent: 'center' }}>
          <T style={{ fontSize: 22 }}>{opt.icon}</T>
        </View>
        <View style={{ flex: 1 }}>
          <T weight='bold' size={15} color={c.ink}>{opt.label}</T>
          <T size={12} color={c.mute} style={{ marginTop: 2 }}>{opt.desc}</T>
        </View>
        {selected && <T size={20} color={c.pink}>✓</T>}
      </View>
    </TouchableOpacity>
  );
}

function RateTypeCard({ opt, selected, onPress }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.82} style={{ flex: 1 }}>
      <View style={{
        backgroundColor: selected ? c.pinkSoft : c.card,
        borderRadius: 16, padding: 14,
        borderWidth: 2, borderColor: selected ? c.pink : c.line,
        alignItems: 'center',
      }}>
        <T style={{ fontSize: 24, marginBottom: 6 }}>{opt.icon}</T>
        <T size={12} weight='bold' color={selected ? c.pink : c.ink} style={{ textAlign: 'center' }}>{opt.label}</T>
      </View>
    </TouchableOpacity>
  );
}

function TierRow({ tier, onChange, onDelete, currency }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.line }}>
      <Field
        label='' value={String(tier.games_from)} onChangeText={v => onChange({ ...tier, games_from: parseInt(v) || 1 })}
        style={{ flex: 1 }} keyboardType='number-pad' placeholder={t('ora.tier_from')}
      />
      <T color={c.mute}>–</T>
      <Field
        label='' value={tier.games_to != null ? String(tier.games_to) : ''} placeholder='∞'
        onChangeText={v => onChange({ ...tier, games_to: v ? parseInt(v) || null : null })}
        style={{ flex: 1 }} keyboardType='number-pad'
      />
      <Field
        label='' value={tier.fee_minor ? String(tier.fee_minor / 100) : ''} placeholder={t('ora.fee')}
        onChangeText={v => onChange({ ...tier, fee_minor: Math.round((parseFloat(v) || 0) * 100) })}
        style={{ flex: 1 }} keyboardType='decimal-pad'
      />
      <TouchableOpacity onPress={onDelete} style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c.redSoft, alignItems: 'center', justifyContent: 'center' }}>
        <T size={14} color={c.red}>✕</T>
      </TouchableOpacity>
    </View>
  );
}

export function OfficialRateAgreementWizard({ route }) {
  const { existingId, mode, note: initialNote } = route?.params ?? {};
  const nav = useNav();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});

  const { data: opts } = useLoad(() => api('GET', '/rate-agreements/options'));

  // Form state
  const [contextType, setContextType] = useState('academy_contract');
  const [counterpartId, setCounterpartId] = useState('');
  const [counterpartOrgId, setCounterpartOrgId] = useState('');
  const [counterpartSearch, setCounterpartSearch] = useState('');
  const [counterpartResults, setCounterpartResults] = useState([]);
  const [sportId, setSportId] = useState('');
  const [officialRole, setOfficialRole] = useState('referee');
  const [rateType, setRateType] = useState('fixed_match');
  const [currency, setCurrency] = useState('GBP');
  const [baseFee, setBaseFee] = useState('');
  const [retainer, setRetainer] = useState('');
  const [travel, setTravel] = useState('');
  const [overtime, setOvertime] = useState('');
  const [accom, setAccom] = useState('');
  const [bundleFee, setBundleFee] = useState('');
  const [bundleDesc, setBundleDesc] = useState('');
  const [tiers, setTiers] = useState([
    { tier_order: 1, games_from: 1, games_to: 10, fee_minor: 0, travel_minor: null },
    { tier_order: 2, games_from: 11, games_to: 25, fee_minor: 0, travel_minor: null },
    { tier_order: 3, games_from: 26, games_to: null, fee_minor: 0, travel_minor: null },
  ]);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveUntil, setEffectiveUntil] = useState('');
  const [autoRenew, setAutoRenew] = useState('notify_30');
  const [noticeDays, setNoticeDays] = useState('14');
  const [cancelFeePct, setCancelFeePct] = useState('');
  const [paymentTrigger, setPaymentTrigger] = useState('per_game');
  const [paymentNetDays, setPaymentNetDays] = useState('30');
  const [officialNote, setOfficialNote] = useState(initialNote ?? '');

  async function searchCounterpart(q) {
    if (q.length < 2) return;
    const res = await api('GET', `/users/search?q=${encodeURIComponent(q)}&role=organiser`);
    setCounterpartResults(res?.results ?? []);
  }

  function addTier() {
    const last = tiers[tiers.length - 1];
    const nextFrom = last ? (last.games_to ?? last.games_from) + 1 : 1;
    setTiers([...tiers, { tier_order: tiers.length + 1, games_from: nextFrom, games_to: null, fee_minor: 0, travel_minor: null }]);
  }
  function updateTier(idx, t) { const copy = [...tiers]; copy[idx] = t; setTiers(copy); }
  function deleteTier(idx) { setTiers(tiers.filter((_, i) => i !== idx).map((t, i) => ({ ...t, tier_order: i + 1 }))); }

  function validate() {
    const e = {};
    if (step === 2 && !counterpartId) e.counterpartId = t('ora.err_counterpart');
    if (step === 2 && !officialRole) e.officialRole = t('ora.err_role');
    if (step === 3 && rateType === 'volume_tiers' && tiers.length < 2) e.tiers = t('ora.err_tiers');
    if (step === 3 && rateType !== 'volume_tiers' && rateType !== 'bundle' && rateType !== 'retainer' && !baseFee) e.baseFee = t('ora.err_fee');
    if (step === 4 && !effectiveFrom) e.effectiveFrom = t('ora.err_date');
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit(propose) {
    if (!validate()) return;
    setBusy(true);
    const body = {
      counterpart_id: counterpartId,
      counterpart_org_id: counterpartOrgId || null,
      context_type: contextType,
      sport_id: sportId || null,
      official_role: officialRole,
      rate_type: rateType,
      currency,
      base_fee_minor: baseFee ? Math.round(parseFloat(baseFee) * 100) : null,
      retainer_minor: retainer ? Math.round(parseFloat(retainer) * 100) : null,
      travel_minor: travel ? Math.round(parseFloat(travel) * 100) : null,
      overtime_minor: overtime ? Math.round(parseFloat(overtime) * 100) : null,
      accom_minor: accom ? Math.round(parseFloat(accom) * 100) : null,
      bundle_minor: bundleFee ? Math.round(parseFloat(bundleFee) * 100) : null,
      bundle_desc: bundleDesc || null,
      tiers: rateType === 'volume_tiers' ? tiers : [],
      effective_from: effectiveFrom,
      effective_until: effectiveUntil || null,
      auto_renew: autoRenew,
      notice_days: noticeDays ? parseInt(noticeDays) : null,
      cancel_fee_pct: cancelFeePct ? parseFloat(cancelFeePct) : null,
      payment_trigger: paymentTrigger || null,
      payment_net_days: paymentNetDays ? parseInt(paymentNetDays) : null,
      official_note: officialNote || null,
      propose,
    };

    let res;
    if (existingId && mode === 'counter') {
      res = await api('POST', `/rate-agreements/${existingId}/counter`, { body: { ...body, note: officialNote } });
    } else {
      res = await api('POST', '/rate-agreements', { body });
    }
    setBusy(false);
    if (res?.id) {
      nav.replace('OfficialRateAgreementDetail', { id: res.id });
    }
  }

  const sports = opts?.sports ?? [];
  const currencies = ['GBP', 'EUR', 'USD', 'AED', 'AUD', 'INR', 'SGD'];
  const roles = ['referee', 'umpire', 'linesman', 'scorer', 'judge', 'starter', 'timekeeper', 'video_referee'];

  // Render steps
  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <>
            <T size={22} weight='bold' color={c.ink}>{t('ora.wiz_s1_title')}</T>
            <T size={13} color={c.mute} style={{ marginTop: 4, marginBottom: 20 }}>{t('ora.wiz_s1_sub')}</T>
            {CONTEXT_OPTIONS.map(opt => (
              <ContextCard key={opt.value} opt={opt} selected={contextType === opt.value} onPress={() => setContextType(opt.value)} />
            ))}
          </>
        );

      case 2:
        return (
          <>
            <T size={22} weight='bold' color={c.ink}>{t('ora.wiz_s2_title')}</T>
            <T size={13} color={c.mute} style={{ marginTop: 4, marginBottom: 20 }}>{t('ora.wiz_s2_sub')}</T>
            <Field
              label={t('ora.wiz_s2_search')} value={counterpartSearch}
              onChangeText={v => { setCounterpartSearch(v); searchCounterpart(v); }}
              placeholder={t('ora.wiz_s2_search_ph')}
              error={errors.counterpartId}
            />
            {counterpartResults.length > 0 && (
              <View style={{ backgroundColor: c.card, borderRadius: 16, borderWidth: 1.5, borderColor: c.line, overflow: 'hidden', marginBottom: 12 }}>
                {counterpartResults.map((r, idx) => (
                  <TouchableOpacity key={r.id} onPress={() => { setCounterpartId(r.id); setCounterpartOrgId(r.org_id ?? ''); setCounterpartSearch(r.org_name ?? r.display_name); setCounterpartResults([]); }}
                    style={{ padding: 14, borderTopWidth: idx > 0 ? 1 : 0, borderTopColor: c.line, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: counterpartId === r.id ? c.pinkSoft : undefined }}>
                    <T size={16}>{r.sport_emoji ?? '🏟️'}</T>
                    <View style={{ flex: 1 }}>
                      <T weight='bold' size={14}>{r.org_name ?? r.display_name}</T>
                      <T size={11} color={c.mute}>{r.location ?? r.email}</T>
                    </View>
                    {counterpartId === r.id && <T size={18} color={c.pink}>✓</T>}
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <MenuField
              label={t('ora.wiz_s2_sport')} value={sportId}
              onChange={setSportId}
              options={[{ value: '', label: t('ora.any_sport') }, ...sports.map(s => ({ value: s.id, label: `${s.emoji} ${s.name}` }))]}
            />
            <MenuField
              label={t('ora.wiz_s2_role')} value={officialRole}
              onChange={setOfficialRole}
              options={roles.map(r => ({ value: r, label: r.charAt(0).toUpperCase() + r.slice(1) }))}
              error={errors.officialRole}
            />
          </>
        );

      case 3:
        return (
          <>
            <T size={22} weight='bold' color={c.ink}>{t('ora.wiz_s3_title')}</T>
            <T size={13} color={c.mute} style={{ marginTop: 4, marginBottom: 16 }}>{t('ora.wiz_s3_sub')}</T>
            <MenuField label={t('ora.currency')} value={currency} onChange={setCurrency}
              options={currencies.map(c => ({ value: c, label: c }))} />
            <T size={12} weight='bold' color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 8, marginBottom: 10 }}>{t('ora.rate_type')}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
              {RATE_TYPE_OPTIONS.map(opt => (
                <View key={opt.value} style={{ width: '47%' }}>
                  <RateTypeCard opt={opt} selected={rateType === opt.value} onPress={() => setRateType(opt.value)} />
                </View>
              ))}
            </View>

            {rateType === 'volume_tiers' && (
              <>
                <T size={12} weight='bold' color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>{t('ora.tiers')}</T>
                {errors.tiers && <T size={12} color={c.red}>{errors.tiers}</T>}
                <View style={{ borderRadius: 16, borderWidth: 1.5, borderColor: c.line, overflow: 'hidden', marginBottom: 12 }}>
                  <View style={{ flexDirection: 'row', backgroundColor: c.violetSoft, padding: 10, gap: 8 }}>
                    {[t('ora.tier_from'), t('ora.tier_to'), t('ora.tier_fee'), ''].map(h => (
                      <T key={h} size={11} weight='bold' color={c.violet} style={{ flex: 1 }}>{h}</T>
                    ))}
                  </View>
                  {tiers.map((tier, idx) => (
                    <TierRow key={idx} tier={tier} currency={currency} onChange={v => updateTier(idx, v)} onDelete={() => deleteTier(idx)} />
                  ))}
                  <TouchableOpacity onPress={addTier} style={{ padding: 12, alignItems: 'center', borderTopWidth: 1, borderTopColor: c.pink + '50', borderStyle: 'dashed' }}>
                    <T size={13} weight='bold' color={c.pink}>+ {t('ora.add_tier')}</T>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {rateType === 'retainer' && (
              <>
                <Field label={t('ora.retainer_monthly')} value={retainer} onChangeText={setRetainer} keyboardType='decimal-pad' placeholder='400.00' />
                <Field label={t('ora.per_game_supplement')} value={baseFee} onChangeText={setBaseFee} keyboardType='decimal-pad' placeholder='95.00' />
              </>
            )}
            {rateType === 'bundle' && (
              <>
                <Field label={t('ora.bundle_total')} value={bundleFee} onChangeText={setBundleFee} keyboardType='decimal-pad' error={errors.baseFee} />
                <Field label={t('ora.bundle_desc')} value={bundleDesc} onChangeText={setBundleDesc} multiline />
              </>
            )}
            {!['volume_tiers', 'retainer', 'bundle'].includes(rateType) && (
              <Field label={t('ora.base_fee')} value={baseFee} onChangeText={setBaseFee} keyboardType='decimal-pad' error={errors.baseFee} placeholder='150.00' />
            )}

            <T size={12} weight='bold' color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 16, marginBottom: 8 }}>{t('ora.additional_rates')}</T>
            <Field label={t('ora.travel_per_game')} value={travel} onChangeText={setTravel} keyboardType='decimal-pad' placeholder={t('ora.optional')} />
            <Field label={t('ora.overtime_per_hour')} value={overtime} onChangeText={setOvertime} keyboardType='decimal-pad' placeholder={t('ora.optional')} />
            <Field label={t('ora.accommodation_per_night')} value={accom} onChangeText={setAccom} keyboardType='decimal-pad' placeholder={t('ora.optional')} />
          </>
        );

      case 4:
        return (
          <>
            <T size={22} weight='bold' color={c.ink}>{t('ora.wiz_s4_title')}</T>
            <T size={13} color={c.mute} style={{ marginTop: 4, marginBottom: 20 }}>{t('ora.wiz_s4_sub')}</T>
            <DatePicker label={t('ora.effective_from')} value={effectiveFrom} onChange={setEffectiveFrom} error={errors.effectiveFrom} />
            <DatePicker label={t('ora.effective_until')} value={effectiveUntil} onChange={setEffectiveUntil} hint={t('ora.optional_open_ended')} />
            <MenuField label={t('ora.auto_renew')} value={autoRenew} onChange={setAutoRenew} options={AUTO_RENEW_OPTIONS} />

            <T size={12} weight='bold' color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 20, marginBottom: 8 }}>{t('ora.cancellation')}</T>
            <Field label={t('ora.notice_days')} value={noticeDays} onChangeText={setNoticeDays} keyboardType='number-pad' />
            <Field label={t('ora.cancel_fee_pct')} value={cancelFeePct} onChangeText={setCancelFeePct} keyboardType='decimal-pad' placeholder={t('ora.optional')} hint={t('ora.cancel_pct_hint')} />

            <T size={12} weight='bold' color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 20, marginBottom: 8 }}>{t('ora.payment_terms')}</T>
            <MenuField label={t('ora.invoice_trigger')} value={paymentTrigger} onChange={setPaymentTrigger} options={PAYMENT_TRIGGER_OPTIONS} />
            <Field label={t('ora.payment_net_days')} value={paymentNetDays} onChangeText={setPaymentNetDays} keyboardType='number-pad' hint={t('ora.net_days_hint')} />

            <T size={12} weight='bold' color={c.mute} style={{ textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 20, marginBottom: 8 }}>{t('ora.private_notes')}</T>
            <Field label={t('ora.note_placeholder')} value={officialNote} onChangeText={setOfficialNote} multiline />
          </>
        );

      case 5: {
        const tierSummary = rateType === 'volume_tiers' && tiers.length
          ? tiers.map(ti => `${money(ti.fee_minor, currency)} (${ti.games_from}${ti.games_to ? `–${ti.games_to}` : '+'} ${t('ora.games')})`).join(', ')
          : null;
        return (
          <>
            <T size={22} weight='bold' color={c.ink}>{t('ora.wiz_s5_title')}</T>
            <T size={13} color={c.mute} style={{ marginTop: 4, marginBottom: 20 }}>{t('ora.wiz_s5_sub')}</T>

            {/* Summary gradient card */}
            <View style={{ borderRadius: 20, padding: 20, backgroundColor: c.pink, marginBottom: 16 }}>
              <T size={11} color='rgba(255,255,255,0.7)' style={{ textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>{CONTEXT_OPTIONS.find(o => o.value === contextType)?.label}</T>
              <T size={18} weight='bold' color='white' style={{ marginBottom: 4 }}>{counterpartSearch || t('ora.counterpart')}</T>
              <T size={13} color='rgba(255,255,255,0.8)' style={{ marginBottom: 14 }}>
                {effectiveFrom}{effectiveUntil ? ` – ${effectiveUntil}` : ''} · {officialRole}
              </T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {[RATE_TYPE_OPTIONS.find(o => o.value === rateType)?.label, tierSummary ?? (baseFee ? money(Math.round(parseFloat(baseFee) * 100), currency) : null), travel ? `+${t('ora.travel')}` : null].filter(Boolean).map(label => (
                  <View key={label} style={{ backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 16 }}>
                    <T size={12} weight='bold' color='white'>{label}</T>
                  </View>
                ))}
              </View>
            </View>

            {tierSummary ? <InfoRow label={t('ora.rt_tiers')} value={tierSummary} /> : null}
            {baseFee ? <InfoRow label={t('ora.base_fee')} value={money(Math.round(parseFloat(baseFee) * 100), currency)} /> : null}
            {retainer ? <InfoRow label={t('ora.retainer')} value={`${money(Math.round(parseFloat(retainer) * 100), currency)} / mo`} /> : null}
            {travel ? <InfoRow label={t('ora.travel')} value={money(Math.round(parseFloat(travel) * 100), currency)} /> : null}
            {overtime ? <InfoRow label={t('ora.overtime')} value={`${money(Math.round(parseFloat(overtime) * 100), currency)} / h`} /> : null}
            <InfoRow label={t('ora.effective_from')} value={effectiveFrom} />
            {effectiveUntil ? <InfoRow label={t('ora.effective_until')} value={effectiveUntil} /> : null}
            {noticeDays ? <InfoRow label={t('ora.notice')} value={`${noticeDays} ${t('ora.days')}`} /> : null}
            {paymentNetDays ? <InfoRow label={t('ora.payment_net')} value={`Net ${paymentNetDays}`} /> : null}

            <View style={{ backgroundColor: c.mintSoft, borderRadius: 12, padding: 12, flexDirection: 'row', gap: 8, marginTop: 16, borderWidth: 1, borderColor: c.mint + '40' }}>
              <T size={16}>🔒</T>
              <T size={12} color='#1A6B56' weight='semibold' style={{ flex: 1, lineHeight: 18 }}>{t('ora.snapshot_notice_send')}</T>
            </View>

            <Btn label={t('ora.send_proposal')} onPress={() => submit(true)} busy={busy} style={{ marginTop: 20, backgroundColor: c.pink }} textColor='white' />
            <Btn label={t('ora.save_draft')} onPress={() => submit(false)} busy={busy} style={{ marginTop: 10, backgroundColor: 'transparent', borderWidth: 0 }} textColor={c.mute} />
          </>
        );
      }
      default: return null;
    }
  };

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4, gap: 10 }}>
        <TouchableOpacity onPress={() => step > 1 ? setStep(step - 1) : nav.goBack()}>
          <T color={c.mute} size={16}>←</T>
        </TouchableOpacity>
        <T weight='bold' size={18} style={{ flex: 1 }}>
          {existingId ? t('ora.counter_title') : t('ora.wiz_title')} ({step}/{STEPS})
        </T>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120 }}>
        <StepIndicator step={step} />
        {renderStep()}
      </ScrollView>

      {step < STEPS && (
        <View style={{ position: 'absolute', bottom: 80, left: 0, right: 0, padding: 20 }}>
          <Btn
            label={t('ora.continue')} onPress={() => { if (validate()) setStep(step + 1); }}
            style={{ backgroundColor: c.pink }} textColor='white'
          />
        </View>
      )}
    </Screen>
  );
}

function InfoRow({ label, value }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <T size={13} color={c.mute} weight='semibold'>{label}</T>
      <T size={13} weight='bold' color={c.ink} style={{ maxWidth: 220, textAlign: 'right' }}>{value}</T>
    </View>
  );
}
