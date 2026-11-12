// Create / Edit official discount form (#1017 / R36).
// All 6 sections: identity, type & value, trigger conditions, eligibility & limits, validity, stacking.
// Adapts to tablet (wide layout). Fully cross-platform.
import React, { useState, useCallback } from 'react';
import { View, Switch, ScrollView, TouchableOpacity, useWindowDimensions } from 'react-native';
import { api } from '../api';
import { useNav } from '../nav';
import { Btn, Card, Field, H2, Screen, T, Tag } from '../ui';
import { c, r } from '../theme';
import { DateField } from '../pickers';
import { money } from '../federation-ui';
import { t } from '../i18n';

const DISCOUNT_TYPES = [
  'recurring_contract', 'event', 'bulk_games',
  'early_commitment', 'loyalty', 'first_booking', 'coupon',
];
const CUSTOMER_TYPES = ['academy', 'event_organiser', 'venue', 'individual'];
const TYPE_ICON = {
  recurring_contract: '🔄', event: '📅', bulk_games: '🎯',
  early_commitment: '⚡', loyalty: '⭐', first_booking: '🎁', coupon: '🏷️',
};

function SectionHeader({ label }) {
  return (
    <View style={{ paddingTop: 20, paddingBottom: 8, borderBottomWidth: 1.5, borderBottomColor: c.line, marginBottom: 14 }}>
      <H2 style={{ fontSize: 15 }}>{label}</H2>
    </View>
  );
}

function ToggleRow({ label, hint, value, onChange }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, marginBottom: 14 }}>
      <View style={{ flex: 1 }}>
        <T size={14} weight='bold' color={c.ink}>{label}</T>
        {hint ? <T size={12} color={c.mute} style={{ marginTop: 2 }}>{hint}</T> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: c.line, true: c.pink }}
        thumbColor={value ? '#fff' : c.paper}
        accessibilityLabel={label}
      />
    </View>
  );
}

function ChipSelect({ options, value, onChange, multi = false }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
      {options.map(o => {
        const selected = multi ? (value ?? []).includes(o.value) : value === o.value;
        return (
          <TouchableOpacity
            key={o.value}
            onPress={() => {
              if (multi) {
                const cur = value ?? [];
                onChange(selected ? cur.filter(v => v !== o.value) : [...cur, o.value]);
              } else {
                onChange(o.value);
              }
            }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected }}
            style={{
              paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
              backgroundColor: selected ? c.pink : c.paper,
              borderWidth: 1.5, borderColor: selected ? c.pink : c.line,
              flexDirection: 'row', alignItems: 'center', gap: 5,
              minHeight: 44,
            }}
          >
            {o.icon ? <T size={14}>{o.icon}</T> : null}
            <T size={13} weight='bold' color={selected ? '#fff' : c.ink}>{o.label}</T>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function NumberStepper({ value, onChange, min = 0, max = 9999, label, hint }) {
  const v = value ?? min;
  return (
    <View style={{ marginBottom: 14 }}>
      {label ? <T size={13} color={c.mute} style={{ marginBottom: 6 }}>{label}</T> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <TouchableOpacity
          onPress={() => onChange(Math.max(min, v - 1))}
          accessibilityLabel={`Decrease ${label ?? ''}`}
          style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}
        >
          <T size={22} color={c.violet}>−</T>
        </TouchableOpacity>
        <View style={{ flex: 1, height: 44, borderRadius: r.input, borderWidth: 1.5, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
          <T size={16} weight='bold' color={c.ink}>{v}</T>
        </View>
        <TouchableOpacity
          onPress={() => onChange(Math.min(max, v + 1))}
          accessibilityLabel={`Increase ${label ?? ''}`}
          style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}
        >
          <T size={22} color={c.pink}>+</T>
        </TouchableOpacity>
      </View>
      {hint ? <T size={11} color={c.mute} style={{ marginTop: 4 }}>{hint}</T> : null}
    </View>
  );
}

export function OfficialDiscountForm({ route }) {
  const nav = useNav();
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const existing = route?.params?.discount ?? null;

  // Section 1: Identity
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');

  // Section 2: Type & Value
  const [kind, setKind] = useState(existing?.kind ?? 'percent');
  const [valueBp, setValueBp] = useState(existing?.value_bp != null ? existing.value_bp / 100 : 10); // show as %
  const [valueMinor, setValueMinor] = useState(existing?.value_minor != null ? existing.value_minor / 100 : 0);
  const [currency, setCurrency] = useState(existing?.currency ?? 'GBP');
  const [fundedBy, setFundedBy] = useState(existing?.funded_by ?? 'referee');

  // Section 3: Trigger
  const [discountType, setDiscountType] = useState(existing?.discount_type ?? 'event');
  const [minBookingCount, setMinBookingCount] = useState(existing?.min_booking_count ?? 5);
  const [minContractValue, setMinContractValue] = useState(existing?.min_contract_value_minor != null ? String(existing.min_contract_value_minor / 100) : '');
  const [daysAdvance, setDaysAdvance] = useState(existing?.days_advance ?? 14);
  const [loyaltyMin, setLoyaltyMin] = useState(existing?.loyalty_min_prior_bookings ?? 3);
  const [code, setCode] = useState(existing?.code ?? '');

  // Section 4: Eligibility
  const [eligibleCustomerTypes, setEligibleCustomerTypes] = useState(existing?.eligible_customer_types ?? ['academy', 'event_organiser']);
  const [maxRedemptions, setMaxRedemptions] = useState(existing?.max_redemptions ?? null);
  const [perCustomerLimit, setPerCustomerLimit] = useState(existing?.per_customer_limit ?? null);
  const [floorMinor, setFloorMinor] = useState(existing?.min_price_floor_minor != null ? String(existing.min_price_floor_minor / 100) : '');

  // Section 5: Validity
  const [validFrom, setValidFrom] = useState(existing?.valid_from ? String(existing.valid_from).slice(0, 10) : null);
  const [validTo, setValidTo] = useState(existing?.valid_to ? String(existing.valid_to).slice(0, 10) : null);
  const [autoApply, setAutoApply] = useState(existing?.auto_apply ?? discountType !== 'coupon');

  // Section 6: Stacking
  const [stackable, setStackable] = useState(existing?.stackable ?? false);
  const [maxStackBp, setMaxStackBp] = useState(existing?.max_stack_discount_bp != null ? existing.max_stack_discount_bp / 100 : 20);

  const [saving, setSaving] = useState(false);
  const [previewResult, setPreviewResult] = useState(null);
  const [error, setError] = useState(null);

  async function handlePreview() {
    try {
      const res = await api.post('/official-discounts/preview', {
        discount_type: discountType,
        kind,
        value_bp: kind === 'percent' ? Math.round(valueBp * 100) : undefined,
        value_minor: kind === 'fixed' ? Math.round(valueMinor * 100) : undefined,
        list_price_minor: 10000, // example £100
        currency,
        game_count: discountType === 'bulk_games' ? minBookingCount : 1,
        booking_days_advance: discountType === 'early_commitment' ? daysAdvance + 1 : 0,
        prior_bookings_count: discountType === 'loyalty' ? loyaltyMin : 0,
        customer_type: eligibleCustomerTypes[0] ?? 'academy',
        coupon_code: discountType === 'coupon' ? code : undefined,
      });
      setPreviewResult(res);
    } catch (e) {
      setError(e?.message ?? 'Preview failed');
    }
  }

  async function handleSubmit(asDraft = false) {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        kind,
        value_bp: kind === 'percent' ? Math.round(valueBp * 100) : undefined,
        value_minor: kind === 'fixed' ? Math.round(valueMinor * 100) : undefined,
        currency: kind === 'fixed' ? currency : undefined,
        funded_by: fundedBy,
        discount_type: discountType,
        code: (discountType === 'coupon' && code.trim()) ? code.trim().toUpperCase() : undefined,
        auto_apply: discountType !== 'coupon' ? autoApply : false,
        min_booking_count: discountType === 'bulk_games' ? minBookingCount : undefined,
        min_contract_value_minor: (discountType === 'recurring_contract' && minContractValue) ? Math.round(parseFloat(minContractValue) * 100) : undefined,
        days_advance: discountType === 'early_commitment' ? daysAdvance : undefined,
        loyalty_min_prior_bookings: discountType === 'loyalty' ? loyaltyMin : undefined,
        eligible_customer_types: eligibleCustomerTypes,
        max_redemptions: maxRedemptions ?? undefined,
        per_customer_limit: perCustomerLimit ?? undefined,
        min_price_floor_minor: floorMinor ? Math.round(parseFloat(floorMinor) * 100) : undefined,
        valid_from: validFrom ?? undefined,
        valid_to: validTo ?? undefined,
        stackable,
        max_stack_discount_bp: stackable ? Math.round(maxStackBp * 100) : undefined,
        status: asDraft ? 'draft' : 'active',
      };

      if (existing?.id) {
        await api.patch(`/official-discounts/${existing.id}`, payload);
      } else {
        await api.post('/official-discounts', payload);
      }
      nav.goBack();
    } catch (e) {
      setError(e?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const colStyle = isTablet ? { flexDirection: 'row', gap: 24 } : {};
  const halfStyle = isTablet ? { flex: 1 } : {};

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 12 }}>
        <TouchableOpacity onPress={() => nav.goBack()} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="Back" accessibilityRole="button">
          <T size={20} color={c.pink}>‹</T>
        </TouchableOpacity>
        <T weight='black' size={18} style={{ flex: 1 }}>{existing ? t('odisc.edit') : t('odisc.create')}</T>
        <TouchableOpacity onPress={() => handleSubmit(true)} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, borderWidth: 1.5, borderColor: c.pink, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
          <T size={13} weight='bold' color={c.pink}>{t('odisc.save_draft')}</T>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>

        {/* ── Section 1: Identity ── */}
        <SectionHeader label="1 · Offer Identity" />
        <Field
          label={t('odisc.name')}
          value={name}
          onChangeText={setName}
          placeholder={t('odisc.name_hint')}
          maxLength={120}
          accessibilityLabel={t('odisc.name')}
        />
        <Field
          label={t('odisc.description')}
          value={description}
          onChangeText={setDescription}
          multiline
          minHeight={72}
          accessibilityLabel={t('odisc.description')}
        />

        {/* ── Section 2: Type & Value ── */}
        <SectionHeader label="2 · Discount Type & Value" />
        <T size={13} color={c.mute} style={{ marginBottom: 8 }}>{t('odisc.kind.percent')} / {t('odisc.kind.fixed')}</T>
        <View style={{ flexDirection: 'row', marginBottom: 14, gap: 8 }}>
          {['percent', 'fixed'].map(k => (
            <TouchableOpacity
              key={k}
              onPress={() => setKind(k)}
              accessibilityRole="radio"
              accessibilityState={{ checked: kind === k }}
              style={{
                flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center',
                backgroundColor: kind === k ? c.pink : c.paper,
                borderWidth: 1.5, borderColor: kind === k ? c.pink : c.line,
                minHeight: 44,
              }}
            >
              <T weight='bold' size={14} color={kind === k ? '#fff' : c.ink}>
                {k === 'percent' ? t('odisc.kind.percent') : t('odisc.kind.fixed')}
              </T>
            </TouchableOpacity>
          ))}
        </View>

        {kind === 'percent' ? (
          <NumberStepper value={valueBp} onChange={setValueBp} min={1} max={100} label={t('odisc.value_pct')} />
        ) : (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Field label={t('odisc.value_fixed')} value={String(valueMinor)} onChangeText={v => setValueMinor(parseFloat(v) || 0)} keyboardType="decimal-pad" accessibilityLabel={t('odisc.value_fixed')} />
            </View>
            <View style={{ width: 80 }}>
              <Field label="Currency" value={currency} onChangeText={v => setCurrency(v.toUpperCase().slice(0, 3))} maxLength={3} accessibilityLabel="Currency" />
            </View>
          </View>
        )}

        {/* Funded by */}
        <T size={13} color={c.mute} style={{ marginBottom: 8 }}>{t('odisc.funded_by')}</T>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
          {[
            { value: 'referee', label: t('odisc.funded_referee') },
            { value: 'platform', label: t('odisc.funded_platform') },
          ].map(fb => (
            <TouchableOpacity
              key={fb.value}
              onPress={() => setFundedBy(fb.value)}
              accessibilityRole="radio"
              accessibilityState={{ checked: fundedBy === fb.value }}
              style={{
                flex: 1, paddingVertical: 10, borderRadius: 12, alignItems: 'center',
                backgroundColor: fundedBy === fb.value ? c.violet : c.paper,
                borderWidth: 1.5, borderColor: fundedBy === fb.value ? c.violet : c.line,
                minHeight: 44,
              }}
            >
              <T weight='bold' size={13} color={fundedBy === fb.value ? '#fff' : c.ink}>{fb.label}</T>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── Section 3: Trigger Conditions ── */}
        <SectionHeader label="3 · Trigger Conditions" />
        <ChipSelect
          options={DISCOUNT_TYPES.map(dt => ({ value: dt, label: t(`odisc.type.${dt}`), icon: TYPE_ICON[dt] }))}
          value={discountType}
          onChange={v => {
            setDiscountType(v);
            if (v !== 'coupon') setAutoApply(true);
            else setAutoApply(false);
          }}
        />

        {/* Dynamic fields per type */}
        {discountType === 'bulk_games' && (
          <NumberStepper value={minBookingCount} onChange={setMinBookingCount} min={2} max={50} label={t('odisc.min_booking_count')} hint="e.g. 5+ games triggers the discount" />
        )}
        {discountType === 'recurring_contract' && (
          <Field label={t('odisc.min_contract_value')} value={minContractValue} onChangeText={setMinContractValue} keyboardType="decimal-pad" hint="Minimum contract value in your base currency" accessibilityLabel={t('odisc.min_contract_value')} />
        )}
        {discountType === 'early_commitment' && (
          <NumberStepper value={daysAdvance} onChange={setDaysAdvance} min={1} max={365} label={t('odisc.days_advance')} hint="Booking must be made this many days before the event" />
        )}
        {discountType === 'loyalty' && (
          <NumberStepper value={loyaltyMin} onChange={setLoyaltyMin} min={1} max={50} label={t('odisc.loyalty_min')} />
        )}
        {discountType === 'coupon' && (
          <Field
            label={t('odisc.code')}
            value={code}
            onChangeText={v => setCode(v.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            hint={t('odisc.code_hint')}
            maxLength={32}
            accessibilityLabel={t('odisc.code')}
          />
        )}

        {/* ── Section 4: Eligibility & Limits ── */}
        <SectionHeader label="4 · Eligibility & Limits" />
        <T size={13} color={c.mute} style={{ marginBottom: 8 }}>{t('odisc.eligible_customer_types')}</T>
        <ChipSelect
          options={CUSTOMER_TYPES.map(ct => ({ value: ct, label: t(`odisc.customer.${ct}`) }))}
          value={eligibleCustomerTypes}
          onChange={setEligibleCustomerTypes}
          multi
        />

        <View style={colStyle}>
          <View style={halfStyle}>
            <NumberStepper
              value={maxRedemptions ?? 0}
              onChange={v => setMaxRedemptions(v > 0 ? v : null)}
              min={0} max={9999}
              label={t('odisc.max_redemptions')}
              hint="0 = unlimited"
            />
          </View>
          <View style={halfStyle}>
            <NumberStepper
              value={perCustomerLimit ?? 0}
              onChange={v => setPerCustomerLimit(v > 0 ? v : null)}
              min={0} max={99}
              label={t('odisc.per_customer_limit')}
              hint="0 = unlimited"
            />
          </View>
        </View>

        <Field
          label={t('odisc.floor_minor')}
          value={floorMinor}
          onChangeText={setFloorMinor}
          keyboardType="decimal-pad"
          hint={t('odisc.floor_minor_hint')}
          accessibilityLabel={t('odisc.floor_minor')}
        />

        {/* ── Section 5: Validity ── */}
        <SectionHeader label="5 · Validity" />
        <View style={colStyle}>
          <View style={halfStyle}>
            <DateField label={t('odisc.valid_from')} value={validFrom} onChange={setValidFrom} optional />
          </View>
          <View style={halfStyle}>
            <DateField label={t('odisc.valid_to')} value={validTo} onChange={setValidTo} optional min={validFrom ?? undefined} />
          </View>
        </View>
        {discountType !== 'coupon' && (
          <ToggleRow
            label={t('odisc.auto_apply')}
            hint={t('odisc.auto_apply_hint')}
            value={autoApply}
            onChange={setAutoApply}
          />
        )}

        {/* ── Section 6: Stacking Rules ── */}
        <SectionHeader label="6 · Stacking Rules" />
        <ToggleRow
          label={t('odisc.stackable')}
          hint={t('odisc.stackable_hint')}
          value={stackable}
          onChange={setStackable}
        />
        {stackable && (
          <NumberStepper
            value={maxStackBp}
            onChange={setMaxStackBp}
            min={1} max={100}
            label={`${t('odisc.max_stack_bp')} (${maxStackBp}%)`}
          />
        )}

        {/* Preview */}
        {previewResult && (
          <Card style={{ marginBottom: 14, backgroundColor: c.mintSoft, borderRadius: 14 }}>
            <T weight='bold' size={14} color={c.ink} style={{ marginBottom: 4 }}>{t('odisc.preview.title')}</T>
            {previewResult.discounts?.length > 0 ? (
              previewResult.discounts.map((d, i) => (
                <T key={i} size={13} color={c.ink}>• {d.name}: save {money(d.saving_minor, currency)}</T>
              ))
            ) : (
              <T size={13} color={c.mute}>{t('odisc.preview.none')}</T>
            )}
          </Card>
        )}

        {error && (
          <View style={{ backgroundColor: c.redSoft, borderRadius: 10, padding: 12, marginBottom: 14 }}>
            <T size={13} color={c.red}>{error}</T>
          </View>
        )}

        {/* Actions */}
        <TouchableOpacity
          onPress={handlePreview}
          style={{ paddingVertical: 14, borderRadius: 12, borderWidth: 1.5, borderColor: c.pink, alignItems: 'center', marginBottom: 12, minHeight: 48 }}
          accessibilityLabel={t('odisc.preview')}
          accessibilityRole="button"
        >
          <T weight='bold' size={15} color={c.pink}>{t('odisc.preview')}</T>
        </TouchableOpacity>

        <Btn
          title={t('odisc.publish')}
          onPress={() => handleSubmit(false)}
          loading={saving}
          color={c.pink}
          accessibilityLabel={t('odisc.publish')}
        />

      </ScrollView>
    </Screen>
  );
}
