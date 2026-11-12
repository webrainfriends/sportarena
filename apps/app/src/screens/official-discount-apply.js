// Apply discount during booking flow (#1017 / R36).
// Shows auto-applied discounts, promo code entry, price breakdown with tax on discounted amount.
import React, { useState, useCallback, useEffect } from 'react';
import { View, TextInput, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { api } from '../api';
import { useNav } from '../nav';
import { Card, Screen, T } from '../ui';
import { c, r } from '../theme';
import { money, fmtDate } from '../federation-ui';
import { t } from '../i18n';

function PriceRow({ label, value, negative, bold, large, color }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 7 }}>
      <T size={large ? 15 : 13} weight={bold ? 'bold' : '500'} color={color ?? c.ink}>{label}</T>
      <T size={large ? 16 : 13} weight={bold ? 'bold' : '500'} color={negative ? c.red : (color ?? c.ink)}>{value}</T>
    </View>
  );
}

export function OfficialDiscountApply({ route }) {
  const nav = useNav();
  const {
    officialId, officialName, officialBadge, officialRating, officialRatingCount,
    gameCount, dateRange, listPriceMinor, currency = 'GBP',
    customerType = 'academy', onConfirm,
  } = route?.params ?? {};

  const subtotalMinor = listPriceMinor * gameCount;
  const taxPct = 20; // passed in production; default for display

  const [codeInput, setCodeInput] = useState('');
  const [codeValidating, setCodeValidating] = useState(false);
  const [codeResult, setCodeResult] = useState(null); // { valid, discount, name, saving_minor }
  const [autoDiscounts, setAutoDiscounts] = useState([]); // auto-applied
  const [appliedDiscount, setAppliedDiscount] = useState(null); // the winning discount
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);

  // Load auto-applied discounts on mount
  useEffect(() => {
    if (!officialId) return;
    api.post('/official-discounts/preview', {
      official_id: officialId,
      discount_type: 'bulk_games',
      game_count: gameCount,
      list_price_minor: subtotalMinor,
      currency,
      customer_type: customerType,
      booking_days_advance: 0,
      prior_bookings_count: 0,
    }).then(res => {
      const autos = (res?.discounts ?? []).filter(d => d.is_auto_apply);
      setAutoDiscounts(autos);
      if (autos.length > 0) setAppliedDiscount(autos[0]);
    }).catch(() => {});
  }, [officialId, gameCount, subtotalMinor]);

  const validateCode = useCallback(async () => {
    if (!codeInput.trim()) return;
    setCodeValidating(true);
    setCodeResult(null);
    try {
      const res = await api.post('/official-discounts/preview', {
        official_id: officialId,
        coupon_code: codeInput.trim().toUpperCase(),
        discount_type: 'coupon',
        game_count: gameCount,
        list_price_minor: subtotalMinor,
        currency,
        customer_type: customerType,
        booking_days_advance: 0,
        prior_bookings_count: 0,
      });
      const hit = (res?.discounts ?? []).find(d => d.code?.toUpperCase() === codeInput.trim().toUpperCase());
      if (hit) {
        setCodeResult({ valid: true, discount: hit });
        // If code gives more saving than auto, prefer it
        if (!appliedDiscount || hit.saving_minor > (appliedDiscount.saving_minor ?? 0)) {
          setAppliedDiscount(hit);
        }
      } else {
        setCodeResult({ valid: false });
      }
    } catch {
      setCodeResult({ valid: false });
    } finally {
      setCodeValidating(false);
    }
  }, [codeInput, officialId, gameCount, subtotalMinor, currency, customerType, appliedDiscount]);

  // Calculate totals
  const discountSaving = appliedDiscount?.saving_minor ?? 0;
  const taxableMinor = subtotalMinor - discountSaving;
  const taxMinor = Math.round(taxableMinor * taxPct / 100);
  const grandTotal = taxableMinor + taxMinor;

  async function handleConfirm() {
    if (!appliedDiscount && !onConfirm) { nav.goBack(); return; }
    setConfirming(true);
    setError(null);
    try {
      if (appliedDiscount?.id) {
        await api.post(`/official-discounts/${appliedDiscount.id}/apply`, {
          official_id: officialId,
          list_price_minor: subtotalMinor,
          currency,
          customer_type: customerType,
          booking_ref_type: 'engagement',
          booking_context: {
            game_count: gameCount,
            booking_days_advance: 0,
            prior_bookings_count: 0,
          },
        });
      }
      onConfirm?.({ discountRedemptionId: appliedDiscount?.redemption_id, grandTotal, discountSaving });
    } catch (e) {
      setError(e?.message ?? 'Failed to apply discount');
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Screen>
      {/* Nav bar */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 10 }}>
        <TouchableOpacity onPress={() => nav.goBack()} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="Back" accessibilityRole="button">
          <T size={20} color={c.pink}>‹</T>
        </TouchableOpacity>
        <T weight='black' size={16} style={{ flex: 1 }}>Confirm Booking · Step 3 of 4</T>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}>

        {/* Referee card */}
        <Card style={{ marginBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 18 }}>
          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
            <T size={22}>👤</T>
          </View>
          <View style={{ flex: 1 }}>
            <T weight='bold' size={15}>{officialName ?? 'Official'}</T>
            {officialBadge ? <T size={12} color={c.mute}>{officialBadge}</T> : null}
            {officialRating ? (
              <T size={12} color={c.sun}>⭐ {officialRating} {officialRatingCount ? `(${officialRatingCount})` : ''}</T>
            ) : null}
          </View>
        </Card>

        {/* Booking summary */}
        <Card style={{ marginBottom: 16, borderRadius: 18 }}>
          <T weight='bold' size={14} color={c.mute} style={{ marginBottom: 8 }}>BOOKING SUMMARY</T>
          <T weight='bold' size={15}>{gameCount} × Match · {money(listPriceMinor, currency)} / game</T>
          {dateRange ? <T size={12} color={c.mute} style={{ marginTop: 2 }}>{dateRange}</T> : null}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.line }}>
            <T size={13} color={c.mute}>{t('odisc.list_price')}</T>
            <T weight='bold' size={14}>{money(subtotalMinor, currency)}</T>
          </View>
        </Card>

        {/* Promo code input */}
        <Card style={{ marginBottom: 16, borderRadius: 18 }}>
          <T weight='bold' size={14} color={c.mute} style={{ marginBottom: 10 }}>{t('odisc.apply_code')}</T>
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <TextInput
              value={codeInput}
              onChangeText={v => setCodeInput(v.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              placeholder={t('odisc.apply_code_hint')}
              placeholderTextColor={c.mute}
              autoCapitalize="characters"
              style={{
                flex: 1, height: 48, borderRadius: r.input, borderWidth: 1.5,
                borderColor: codeResult?.valid === false ? c.red : codeResult?.valid ? c.lime : c.line,
                paddingHorizontal: 14, fontSize: 15, color: c.ink,
                backgroundColor: c.paper, letterSpacing: 1.5, fontWeight: '700',
              }}
              accessibilityLabel={t('odisc.apply_code')}
              returnKeyType="done"
              onSubmitEditing={validateCode}
            />
            <TouchableOpacity
              onPress={validateCode}
              disabled={!codeInput.trim() || codeValidating}
              style={{ height: 48, paddingHorizontal: 16, borderRadius: r.input, backgroundColor: c.pink, alignItems: 'center', justifyContent: 'center' }}
              accessibilityLabel="Apply code"
            >
              {codeValidating
                ? <ActivityIndicator color="#fff" size="small" />
                : <T weight='bold' size={13} color='#fff'>Apply</T>
              }
            </TouchableOpacity>
          </View>

          {codeResult?.valid === true && (
            <View style={{ marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ backgroundColor: c.mintSoft, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, flex: 1 }}>
                <T size={13} color={c.mint} weight='bold'>
                  {t('odisc.apply_code_valid', { name: codeResult.discount?.name ?? codeInput })}
                </T>
              </View>
              <View style={{ backgroundColor: c.cyanSoft, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
                <T size={12} color={c.cyan} weight='bold'>
                  {t('odisc.preview.saving', { amount: money(codeResult.discount?.saving_minor ?? 0, currency) })}
                </T>
              </View>
            </View>
          )}
          {codeResult?.valid === false && (
            <T size={13} color={c.red} style={{ marginTop: 8 }}>{t('odisc.apply_code_invalid')}</T>
          )}
        </Card>

        {/* Auto-applied discounts */}
        {autoDiscounts.length > 0 && (
          <View style={{ backgroundColor: c.sunSoft, borderRadius: 14, padding: 12, marginBottom: 16 }}>
            <T size={13} color={c.sun} weight='bold' style={{ marginBottom: 4 }}>Auto-applied discounts</T>
            {autoDiscounts.map((d, i) => (
              <T key={i} size={13} color={c.ink}>{t('odisc.auto_applied', { name: d.name })}</T>
            ))}
            {appliedDiscount && (
              <View style={{ marginTop: 8, backgroundColor: c.paper, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
                <T size={12} color={c.sun} weight='bold'>
                  Best discount applied: save {money(discountSaving, currency)}
                  {appliedDiscount.funded_by === 'platform' ? ' (platform-funded)' : appliedDiscount.funded_by === 'referee' ? ' (referee-funded)' : ''}
                </T>
              </View>
            )}
          </View>
        )}

        {/* Price breakdown */}
        <Card style={{ marginBottom: 16, borderRadius: 18 }}>
          <T weight='bold' size={14} color={c.mute} style={{ marginBottom: 8 }}>PRICE BREAKDOWN</T>
          <View style={{ borderTopWidth: 1, borderTopColor: c.line, paddingTop: 8 }}>
            <PriceRow label={t('odisc.list_price')} value={money(subtotalMinor, currency)} />
            {discountSaving > 0 && (
              <PriceRow
                label={t('odisc.discount_line', { name: appliedDiscount?.name ?? 'Discount' })}
                value={`−${money(discountSaving, currency)}`}
                negative
              />
            )}
            <View style={{ height: 1, backgroundColor: c.line, marginVertical: 6 }} />
            <PriceRow label={t('odisc.taxable_amount')} value={money(taxableMinor, currency)} />
            <PriceRow label={t('odisc.tax_line', { pct: taxPct })} value={money(taxMinor, currency)} />
            <View style={{ height: 1.5, backgroundColor: c.ink, marginVertical: 8 }} />
            <PriceRow
              label={t('odisc.total')}
              value={money(grandTotal, currency)}
              bold large
              color={c.pink}
            />
          </View>

          {discountSaving > 0 && (
            <View style={{ marginTop: 10, backgroundColor: c.mintSoft, borderRadius: 10, padding: 10 }}>
              <T size={13} weight='bold' color={c.mint}>
                {t('odisc.saving_total', { amount: money(discountSaving, currency) })}
              </T>
              {appliedDiscount?.funded_by && (
                <T size={12} color={c.mute} style={{ marginTop: 2 }}>
                  {t('odisc.funded_note', {
                    amount: money(discountSaving, currency),
                    party: appliedDiscount.funded_by === 'platform' ? 'GotMyGame Platform' : officialName ?? 'referee',
                  })}
                </T>
              )}
            </View>
          )}
        </Card>

        {error && (
          <View style={{ backgroundColor: c.redSoft, borderRadius: 10, padding: 12, marginBottom: 14 }}>
            <T size={13} color={c.red}>{error}</T>
          </View>
        )}

        {/* Confirm */}
        <TouchableOpacity
          onPress={handleConfirm}
          disabled={confirming}
          style={{ backgroundColor: c.pink, borderRadius: 14, paddingVertical: 16, alignItems: 'center', minHeight: 54 }}
          accessibilityLabel="Confirm and send quote"
          accessibilityRole="button"
        >
          {confirming
            ? <ActivityIndicator color="#fff" />
            : <T weight='bold' size={16} color='#fff'>Confirm & Send Quote</T>
          }
        </TouchableOpacity>

      </ScrollView>
    </Screen>
  );
}
