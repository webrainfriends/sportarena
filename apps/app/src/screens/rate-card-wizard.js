// Rate Card Wizard (#1015 R34). 7-step wizard for creating or editing a referee rate card.
// Separate from the 10-step official-profile-wizard; complements it via the Service Catalog screen.
// API: official-rate-card capability.
import React, { useState, useEffect } from 'react';
import { View, Pressable, TouchableOpacity } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { Btn, Card, Chip, Empty, ErrorBox, Loading, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { c } from '../theme';
import { t } from '../i18n';
import { money } from '../federation-ui';

const STEP_KEYS = ['type','sport','price','premium','terms','visible','review'];
const FIX_TYPES = ['training','friendly','cup','league','tournament','international','other'];
const ROLE_OPTS = ['referee','umpire','linesman','scorer','judge','starter','timekeeper','video_referee'];
const CURRENCIES = ['GBP','EUR','USD','AED','INR','AUD','CAD','ZAR'];
const SERVICE_TYPES = ['hourly','match','session','day'];
const DEPOSIT_TYPES = ['none','pct','fixed'];
const AGE_BANDS = ['u8','u10','u12','u14','u16','u18','u21','senior','masters','all'];

const empty = () => ({
  name: '', service_type: 'match',
  sport_id: null, role: 'referee', fixture_type: 'league', level_label: '',
  fee_minor: 0, fee_currency: 'GBP', min_fee_minor: 0,
  weekend_sat_pct: 0, weekend_sun_pct: 0, holiday_pct: 0, overtime_rate_minor: 0,
  deposit_type: 'none', deposit_pct: 0, deposit_minor: 0, tax_inclusive: true,
  includes_travel: false, travel_allowance_per_km_minor: 0, travel_radius_km: 10,
  valid_from: '', valid_until: '',
  is_indicative: true, private_notes: '',
  status: 'draft',
  // R15
  age_bands: [], callout_fee_minor: 0, extra_time_rate_minor: 0,
  per_diem_minor: 0, cancellation_tiers: [], tax_rate_pct: 0,
});

function StepHeader({ step }) {
  return (
    <View style={{ gap: 6, marginBottom: 12 }}>
      <View style={{ flexDirection: 'row', gap: 4 }}>
        {STEP_KEYS.map((k, i) => (
          <View key={k} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i <= step ? c.pink : c.line }} />
        ))}
      </View>
      <T size={11} color={c.mute}>{t(`rc.step_${STEP_KEYS[step]}`)} · {t('rc.step_review')} {step + 1}/{STEP_KEYS.length}</T>
    </View>
  );
}

// Step 1: Service Identity
function StepType({ data, onChange, onNext }) {
  return (
    <View style={{ gap: 12 }}>
      <StepHeader step={0} />
      <Card>
        <T weight="800">{t('rc.name_label')}</T>
        <FormSheet inline visible
          initial={{ name: data.name }}
          fields={[{ key: 'name', label: t('rc.name_label'), placeholder: t('rc.name_hint'), hint: t('rc.name_hint') }]}
          onSubmit={(x) => onChange(x)}
          onClose={() => {}}
        />
      </Card>
      <Card>
        <T weight="800" style={{ marginBottom: 8 }}>{t('rc.service_type_label')}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {SERVICE_TYPES.map((st) => (
            <Pressable key={st} onPress={() => onChange({ service_type: st })}
              style={{ flex: 1, minWidth: '45%', borderWidth: 2, borderColor: data.service_type === st ? c.pink : c.line,
                borderRadius: 14, padding: 14, alignItems: 'center',
                backgroundColor: data.service_type === st ? c.pinkSoft : c.paper }}
              accessibilityRole="radio" accessibilityState={{ checked: data.service_type === st }}
              accessibilityLabel={t(`rc.type_${st}`)}>
              <T size={26}>{st === 'hourly' ? '⏱' : st === 'match' ? '🏟' : st === 'session' ? '📋' : '📅'}</T>
              <T weight="700" size={14} style={{ marginTop: 4 }}>{t(`rc.type_${st}`)}</T>
            </Pressable>
          ))}
        </View>
      </Card>
      <Btn title={t('common.next')} onPress={onNext} accessibilityLabel={t('common.next')} />
    </View>
  );
}

// Step 2: Sport & Role
function StepSport({ data, onChange, sportOpts, onNext, onBack }) {
  return (
    <View style={{ gap: 12 }}>
      <StepHeader step={1} />
      <Card>
        <MenuField label={t('opw.f.sport')} value={data.sport_id} onChange={(v) => onChange({ sport_id: v })}
          options={[{ value: null, label: t('opw.rates.all_sports') }, ...sportOpts]} />
        <MenuField label={t('opw.f.role')} value={data.role} onChange={(v) => onChange({ role: v })}
          options={ROLE_OPTS.map((v) => ({ value: v, label: t(`opw.role.${v}`) }))} />
        <MenuField label={t('opw.f.fixture_type')} value={data.fixture_type} onChange={(v) => onChange({ fixture_type: v })}
          options={FIX_TYPES.map((v) => ({ value: v, label: t(`opw.fix.${v}`) }))} />
        <FormSheet inline visible
          initial={{ level_label: data.level_label }}
          fields={[{ key: 'level_label', label: t('opw.f.level'), placeholder: 'e.g. National Elite', optional: true }]}
          onSubmit={(x) => onChange(x)}
          onClose={() => {}}
        />
      </Card>
      <Card>
        <T weight="800" style={{ marginBottom: 4 }}>{t('rc.age_bands')}</T>
        <T size={12} color={c.mute} style={{ marginBottom: 10 }}>{t('rc.age_bands_hint')}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {AGE_BANDS.map((ab) => {
            const active = (data.age_bands ?? []).includes(ab);
            return (
              <Pressable key={ab} onPress={() => {
                const cur = data.age_bands ?? [];
                onChange({ age_bands: active ? cur.filter((x) => x !== ab) : [...cur, ab] });
              }}
                style={{ borderWidth: 2, borderColor: active ? c.pink : c.line, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: active ? c.pinkSoft : c.paper }}
                accessibilityRole="checkbox" accessibilityState={{ checked: active }}
                accessibilityLabel={t(`rc.age.${ab}`)}>
                <T size={13} weight={active ? '700' : '400'} color={active ? c.pink : c.ink}>{t(`rc.age.${ab}`)}</T>
              </Pressable>
            );
          })}
        </View>
      </Card>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title={t('common.back')} color={c.paper} ink={c.ink} onPress={onBack} />
        <Btn title={t('common.next')} onPress={onNext} />
      </View>
    </View>
  );
}

// Step 3: Pricing
function StepPrice({ data, onChange, onNext, onBack }) {
  const feeVal = Number(data.fee_minor ?? 0);
  const minVal = Number(data.min_fee_minor ?? 0);
  const calloutVal = Number(data.callout_fee_minor ?? 0);
  return (
    <View style={{ gap: 12 }}>
      <StepHeader step={2} />
      <Card>
        <T weight="800" style={{ marginBottom: 8 }}>{t('opw.f.currency')}</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {CURRENCIES.map((cur) => (
            <Chip key={cur} label={cur} active={data.fee_currency === cur} onPress={() => onChange({ fee_currency: cur })} />
          ))}
        </View>
      </Card>
      <Card>
        <FormSheet inline visible
          initial={{ fee_minor: data.fee_minor, min_fee_minor: data.min_fee_minor }}
          fields={[
            { key: 'fee_minor', label: t('rc.base_fee'), type: 'stepper', min: 0, max: 1000000, step: 500, hint: `${t('rc.fee_hint')} = ${(feeVal / 100).toFixed(2)} ${data.fee_currency}` },
            { key: 'min_fee_minor', label: t('rc.min_fee'), type: 'stepper', min: 0, max: 500000, step: 500, hint: `= ${(minVal / 100).toFixed(2)} ${data.fee_currency}`, optional: true },
            { key: 'callout_fee_minor', label: t('rc.callout_fee'), type: 'stepper', min: 0, max: 500000, step: 500, hint: `${t('rc.callout_fee_hint')} = ${(calloutVal / 100).toFixed(2)} ${data.fee_currency}`, optional: true },
          ]}
          onSubmit={(x) => onChange(x)}
          onClose={() => {}}
        />
      </Card>
      <Card color={c.cyanSoft}>
        <T size={12} color={c.cyan}>{`ℹ️ ${t('rc.vis_indicative_sub')}`}</T>
      </Card>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title={t('common.back')} color={c.paper} ink={c.ink} onPress={onBack} />
        <Btn title={t('common.next')} onPress={onNext} />
      </View>
    </View>
  );
}

// Step 4: Premiums & Overtime
function StepPremium({ data, onChange, onNext, onBack }) {
  const base = Number(data.fee_minor ?? 0);
  const preview = [
    { label: 'Weekday', amount: base },
    { label: `${t('rc.weekend_sat')} (+${data.weekend_sat_pct}%)`, amount: Math.round(base * (1 + Number(data.weekend_sat_pct) / 100)) },
    { label: `${t('rc.weekend_sun')} (+${data.weekend_sun_pct}%)`, amount: Math.round(base * (1 + Number(data.weekend_sun_pct) / 100)) },
    { label: `${t('rc.holiday')} (+${data.holiday_pct}%)`, amount: Math.round(base * (1 + Number(data.holiday_pct) / 100)) },
  ];
  return (
    <View style={{ gap: 12 }}>
      <StepHeader step={3} />
      <Card>
        <FormSheet inline visible
          initial={{ weekend_sat_pct: data.weekend_sat_pct, weekend_sun_pct: data.weekend_sun_pct, holiday_pct: data.holiday_pct, overtime_rate_minor: data.overtime_rate_minor }}
          fields={[
            { key: 'weekend_sat_pct', label: t('rc.weekend_sat'), type: 'stepper', min: 0, max: 100, step: 5, hint: '%' },
            { key: 'weekend_sun_pct', label: t('rc.weekend_sun'), type: 'stepper', min: 0, max: 100, step: 5, hint: '%' },
            { key: 'holiday_pct', label: t('rc.holiday'), type: 'stepper', min: 0, max: 100, step: 5, hint: '%' },
            { key: 'overtime_rate_minor', label: t('rc.overtime'), type: 'stepper', min: 0, max: 100000, step: 100, hint: `= ${(Number(data.overtime_rate_minor) / 100).toFixed(2)} ${data.fee_currency}/hr` },
            { key: 'extra_time_rate_minor', label: t('rc.extra_time'), type: 'stepper', min: 0, max: 100000, step: 100, hint: `${t('rc.extra_time_hint')} = ${(Number(data.extra_time_rate_minor ?? 0) / 100).toFixed(2)} ${data.fee_currency}`, optional: true },
          ]}
          onSubmit={(x) => onChange(x)}
          onClose={() => {}}
        />
      </Card>
      {/* Premium preview */}
      <Card color={c.violetSoft}>
        <T weight="700" size={13} color={c.pink} style={{ marginBottom: 8 }}>{t('rc.prem_preview')}</T>
        {preview.map((p) => (
          <View key={p.label} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
            <T size={12} color={c.mute}>{p.label}</T>
            <T size={12} weight="700">{(p.amount / 100).toFixed(2)} {data.fee_currency}</T>
          </View>
        ))}
      </Card>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title={t('common.back')} color={c.paper} ink={c.ink} onPress={onBack} />
        <Btn title={t('common.next')} onPress={onNext} />
      </View>
    </View>
  );
}

// Step 5: Terms (deposit, travel, tax, dates, per diem, cancellation tiers)
function StepTerms({ data, onChange, onNext, onBack }) {
  const tiers = data.cancellation_tiers ?? [];
  const addTier = () => {
    if (tiers.length >= 5) return;
    onChange({ cancellation_tiers: [...tiers, { notice_hrs: 48, fee_pct: 100 }] });
  };
  const removeTier = (idx) => onChange({ cancellation_tiers: tiers.filter((_, i) => i !== idx) });
  const updateTier = (idx, field, val) => {
    const next = tiers.map((t, i) => i === idx ? { ...t, [field]: Number(val) } : t);
    onChange({ cancellation_tiers: next });
  };
  return (
    <View style={{ gap: 12 }}>
      <StepHeader step={4} />
      <Card>
        <T weight="800" style={{ marginBottom: 8 }}>{t('rc.deposit_label')}</T>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
          {DEPOSIT_TYPES.map((dt) => (
            <Chip key={dt} label={t(`rc.deposit_${dt}`)} active={data.deposit_type === dt} onPress={() => onChange({ deposit_type: dt })} />
          ))}
        </View>
        {data.deposit_type === 'pct' ? (
          <FormSheet inline visible
            initial={{ deposit_pct: data.deposit_pct }}
            fields={[{ key: 'deposit_pct', label: `${t('rc.deposit_label')} (%)`, type: 'stepper', min: 0, max: 100, step: 5, hint: `= ${((Number(data.deposit_pct) / 100) * (Number(data.fee_minor) / 100)).toFixed(2)} ${data.fee_currency} on base fee` }]}
            onSubmit={(x) => onChange(x)}
            onClose={() => {}}
          />
        ) : data.deposit_type === 'fixed' ? (
          <FormSheet inline visible
            initial={{ deposit_minor: data.deposit_minor }}
            fields={[{ key: 'deposit_minor', label: `${t('rc.deposit_label')} (fixed)`, type: 'stepper', min: 0, max: 500000, step: 500, hint: `= ${(Number(data.deposit_minor) / 100).toFixed(2)} ${data.fee_currency}` }]}
            onSubmit={(x) => onChange(x)}
            onClose={() => {}}
          />
        ) : null}
      </Card>
      <Card>
        <FormSheet inline visible
          initial={{ tax_inclusive: data.tax_inclusive, includes_travel: data.includes_travel, travel_allowance_per_km_minor: data.travel_allowance_per_km_minor, travel_radius_km: data.travel_radius_km, valid_from: data.valid_from, valid_until: data.valid_until }}
          fields={[
            { key: 'tax_inclusive', label: t('rc.tax_inclusive'), type: 'switch', hint: t('rc.tax_inclusive_sub') },
            { key: 'includes_travel', label: t('rc.travel_included'), type: 'switch' },
            { key: 'travel_allowance_per_km_minor', label: t('rc.travel_per_km'), type: 'stepper', min: 0, max: 5000, step: 5, hint: `= ${(Number(data.travel_allowance_per_km_minor) / 100).toFixed(2)} ${data.fee_currency}/km` },
            { key: 'travel_radius_km', label: t('rc.travel_radius'), type: 'stepper', min: 0, max: 500, step: 5, hint: 'km' },
            { key: 'valid_from', label: t('rc.valid_from'), type: 'date', optional: true },
            { key: 'valid_until', label: t('rc.valid_until'), type: 'date', optional: true },
          ]}
          onSubmit={(x) => onChange(x)}
          onClose={() => {}}
        />
      </Card>
      {/* R15: Per diem + tax rate */}
      <Card>
        <FormSheet inline visible
          initial={{ per_diem_minor: data.per_diem_minor ?? 0, tax_rate_pct: data.tax_rate_pct ?? 0 }}
          fields={[
            { key: 'per_diem_minor', label: t('rc.per_diem'), type: 'stepper', min: 0, max: 500000, step: 500, hint: `${t('rc.per_diem_hint')} = ${(Number(data.per_diem_minor ?? 0) / 100).toFixed(2)} ${data.fee_currency}/day`, optional: true },
            { key: 'tax_rate_pct', label: t('rc.tax_rate'), type: 'stepper', min: 0, max: 60, step: 0.5, hint: t('rc.tax_rate_hint'), optional: true },
          ]}
          onSubmit={(x) => onChange(x)}
          onClose={() => {}}
        />
      </Card>
      {/* R15: Cancellation tiers */}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
          <View style={{ flex: 1 }}>
            <T weight="800">{t('rc.cancellation_tiers')}</T>
            <T size={12} color={c.mute}>{t('rc.cancellation_tiers_hint')}</T>
          </View>
          {tiers.length < 5 ? (
            <TouchableOpacity onPress={addTier} style={{ backgroundColor: c.pinkSoft, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }} accessibilityLabel={t('rc.cancel_add_tier')}>
              <T size={12} weight="700" color={c.pink}>+ {t('rc.cancel_add_tier')}</T>
            </TouchableOpacity>
          ) : null}
        </View>
        {tiers.length === 0 ? (
          <T size={12} color={c.mute} style={{ paddingVertical: 8, textAlign: 'center' }}>No cancellation tiers — full refund applies.</T>
        ) : null}
        {tiers.map((tier, idx) => (
          <View key={idx} style={{ borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 10, marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1, gap: 6 }}>
              <FormSheet inline visible
                initial={{ notice_hrs: tier.notice_hrs, fee_pct: tier.fee_pct }}
                fields={[
                  { key: 'notice_hrs', label: t('rc.cancel_notice_hrs'), type: 'stepper', min: 0, max: 720, step: 12, hint: 'hours' },
                  { key: 'fee_pct', label: t('rc.cancel_fee_pct'), type: 'stepper', min: 0, max: 100, step: 5, hint: '%' },
                ]}
                onSubmit={(x) => { updateTier(idx, 'notice_hrs', x.notice_hrs); updateTier(idx, 'fee_pct', x.fee_pct); }}
                onClose={() => {}}
              />
              <T size={11} color={c.mute}>≤ {tier.notice_hrs}h notice → {tier.fee_pct}% cancellation fee</T>
            </View>
            <TouchableOpacity onPress={() => removeTier(idx)} accessibilityLabel={t('rc.cancel_remove_tier')}>
              <T size={18} color={c.red}>✕</T>
            </TouchableOpacity>
          </View>
        ))}
      </Card>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title={t('common.back')} color={c.paper} ink={c.ink} onPress={onBack} />
        <Btn title={t('common.next')} onPress={onNext} />
      </View>
    </View>
  );
}

// Step 6: Visibility
function StepVisible({ data, onChange, onNext, onBack }) {
  return (
    <View style={{ gap: 12 }}>
      <StepHeader step={5} />
      <T size={13} color={c.mute} style={{ marginHorizontal: 4 }}>{t('rc.vis_indicative_sub')}</T>
      {[{ val: true, label: t('rc.vis_indicative'), sub: t('rc.vis_indicative_sub'), icon: '🌍' }, { val: false, label: t('rc.vis_negotiated'), sub: t('rc.vis_negotiated_sub'), icon: '🔐' }].map(({ val, label, sub, icon }) => (
        <Pressable key={String(val)} onPress={() => onChange({ is_indicative: val })}
          style={{ borderWidth: 2, borderColor: data.is_indicative === val ? c.pink : c.line, borderRadius: 14, padding: 14,
            backgroundColor: data.is_indicative === val ? c.pinkSoft : c.paper, flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}
          accessibilityRole="radio" accessibilityState={{ checked: data.is_indicative === val }}
          accessibilityLabel={label}>
          <T size={28}>{icon}</T>
          <View style={{ flex: 1 }}>
            <T weight="700" size={14}>{label}</T>
            <T size={12} color={c.mute} style={{ marginTop: 3 }}>{sub}</T>
          </View>
          {data.is_indicative === val ? <T size={18} color={c.pink}>✓</T> : null}
        </Pressable>
      ))}
      <Card>
        <FormSheet inline visible
          initial={{ private_notes: data.private_notes }}
          fields={[{ key: 'private_notes', label: `🔒 ${t('rc.private_notes')}`, type: 'multiline', optional: true, hint: t('rc.private_notes_hint') }]}
          onSubmit={(x) => onChange(x)}
          onClose={() => {}}
        />
      </Card>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title={t('common.back')} color={c.paper} ink={c.ink} onPress={onBack} />
        <Btn title={t('common.next')} onPress={onNext} />
      </View>
    </View>
  );
}

// Step 7: Review & Activate
function StepReview({ data, sportOpts, onBack, onSave, busy }) {
  const sportName = sportOpts.find((s) => s.value === data.sport_id)?.label ?? '—';
  const rows = [
    [t('rc.name_label'), data.name || '—'],
    [t('rc.service_type_label'), data.service_type ? t(`rc.type_${data.service_type}`) : '—'],
    [t('opw.f.sport'), sportName],
    [t('opw.f.role'), data.role ? t(`opw.role.${data.role}`) : '—'],
    [t('opw.f.fixture_type'), data.fixture_type ? t(`opw.fix.${data.fixture_type}`) : '—'],
    [t('rc.base_fee'), `${money(data.fee_minor, data.fee_currency)}/${data.service_type ?? 'match'}`],
    ...(data.min_fee_minor > 0 ? [[t('rc.min_fee'), money(data.min_fee_minor, data.fee_currency)]] : []),
    [t('rc.weekend_sat'), `+${data.weekend_sat_pct ?? 0}% / +${data.weekend_sun_pct ?? 0}%`],
    [t('rc.holiday'), `+${data.holiday_pct ?? 0}%`],
    ...(data.overtime_rate_minor > 0 ? [[t('rc.overtime'), `${money(data.overtime_rate_minor, data.fee_currency)}/hr`]] : []),
    [t('rc.deposit_label'), data.deposit_type === 'pct' ? `${data.deposit_pct}%` : data.deposit_type === 'fixed' ? money(data.deposit_minor, data.fee_currency) : t('rc.deposit_none')],
    [t('rc.travel_per_km'), data.includes_travel ? t('rc.travel_included') : (data.travel_allowance_per_km_minor > 0 ? `${money(data.travel_allowance_per_km_minor, data.fee_currency)}/km` : '—')],
    [t('rc.tax_inclusive'), data.tax_inclusive ? '✓' : '—'],
    ...(data.tax_rate_pct > 0 ? [[t('rc.tax_rate'), `${data.tax_rate_pct}%`]] : []),
    [t('rc.valid_from'), data.valid_from || '—'],
    [t('rc.valid_until'), data.valid_until || t('common.open')],
    [t('rc.vis_indicative'), data.is_indicative ? `🌍 ${t('rc.vis_indicative')}` : `🔐 ${t('rc.vis_negotiated')}`],
    [t('rc.version'), 'v1 (new)'],
    // R15
    [t('rc.age_bands'), (data.age_bands ?? []).length > 0 ? (data.age_bands ?? []).map((ab) => t(`rc.age.${ab}`)).join(', ') : t('rc.age.all')],
    ...(data.callout_fee_minor > 0 ? [[t('rc.callout_fee'), money(data.callout_fee_minor, data.fee_currency)]] : []),
    ...(data.extra_time_rate_minor > 0 ? [[t('rc.extra_time'), `${money(data.extra_time_rate_minor, data.fee_currency)}/period`]] : []),
    ...(data.per_diem_minor > 0 ? [[t('rc.per_diem'), `${money(data.per_diem_minor, data.fee_currency)}/day`]] : []),
    [t('rc.cancellation_tiers'), (data.cancellation_tiers ?? []).length > 0 ? `${(data.cancellation_tiers ?? []).length} tier${(data.cancellation_tiers ?? []).length !== 1 ? 's' : ''}` : 'None'],
  ];
  return (
    <View style={{ gap: 12 }}>
      <StepHeader step={6} />
      <T weight="800" size={18}>{data.name || t('rc.review_title')}</T>
      <T size={13} color={c.mute}>{t('rc.review_sub')}</T>
      <Card>
        {rows.map(([k, v]) => (
          <View key={k} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line }}>
            <T size={13} color={c.mute}>{k}</T>
            <T size={13} weight="600" style={{ maxWidth: '55%', textAlign: 'right' }}>{v}</T>
          </View>
        ))}
      </Card>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title={t('common.back')} color={c.paper} ink={c.ink} onPress={onBack} />
        <Btn title={t('rc.save_draft')} color={c.violetSoft} ink={c.violet} onPress={() => onSave('draft')} loading={busy === 'draft'} />
        <Btn title={`🚀 ${t('rc.review_activate')}`} color={c.lime} onPress={() => onSave('active')} loading={busy === 'active'} />
      </View>
    </View>
  );
}

export function RateCardWizard({ id: editId }) {
  const { pop } = useNav();
  const { toast } = useSession();
  const [step, setStep] = useState(0);
  const [data, setData] = useState(empty());
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  const opts = useLoad(() => api.get('/me/official-profile/options'), []);
  const existing = useLoad(() => (editId ? api.get(`/me/official-profile/rate-cards/catalog`).then((cards) => cards.find((c) => c.id === editId)) : Promise.resolve(null)), [editId]);

  useEffect(() => {
    if (existing.data) setData({ ...empty(), ...existing.data, private_notes: existing.data.private_notes ?? '' });
  }, [existing.data]);

  const sportOpts = (opts.data?.sports ?? []).map((s) => ({ value: s.id, label: `${s.emoji} ${s.name}` }));
  const merge = (patch) => setData((d) => ({ ...d, ...patch }));

  const save = async (status) => {
    setBusy(status);
    setErr(null);
    try {
      const payload = { ...data, status };
      if (editId) await api.put(`/me/official-profile/rate-cards/${editId}`, payload);
      else await api.post('/me/official-profile/rate-cards', payload);
      toast(status === 'active' ? t('rc.activate') : t('rc.save_draft'));
      pop();
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };

  if (opts.error || existing.error) return <Sheet visible onClose={pop} title={t('rc.title')}><ErrorBox error={opts.error ?? existing.error} onRetry={() => { opts.reload(); existing.reload(); }} /></Sheet>;
  if (!opts.data) return <Sheet visible onClose={pop} title={t('rc.title')}><Loading /></Sheet>;

  const stepProps = { data, onChange: merge, onBack: () => setStep((s) => s - 1), onNext: () => setStep((s) => s + 1), sportOpts };

  return (
    <Sheet visible onClose={pop} title={editId ? t('rc.edit') : t('rc.new')}>
      {err ? <T color={c.red} size={13} style={{ marginBottom: 8 }}>{err}</T> : null}
      {step === 0 ? <StepType {...stepProps} /> : null}
      {step === 1 ? <StepSport {...stepProps} /> : null}
      {step === 2 ? <StepPrice {...stepProps} /> : null}
      {step === 3 ? <StepPremium {...stepProps} /> : null}
      {step === 4 ? <StepTerms {...stepProps} /> : null}
      {step === 5 ? <StepVisible {...stepProps} /> : null}
      {step === 6 ? <StepReview {...stepProps} onSave={save} busy={busy} /> : null}
    </Sheet>
  );
}
