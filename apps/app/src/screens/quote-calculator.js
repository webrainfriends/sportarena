// Quote Calculator (#1015 R34). Counterpart/organiser view to build an instant fee estimate from an official's rate card.
// API: official-rate-card capability (GET /official-profiles/:id/rate-cards, POST .../quote).
import React, { useState, useEffect } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { Btn, Card, Chip, Empty, GradCard, Loading, Screen, Section, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField } from '../menu-field';
import { LoadError } from '../access';
import { c, grad } from '../theme';
import { t } from '../i18n';
import { money } from '../federation-ui';

function BreakdownLine({ label, amount, currency, style }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: c.line }}>
      <T size={13} color={c.mute}>{label}</T>
      <T size={14} weight="700" style={style}>{money(amount, currency)}</T>
    </View>
  );
}

export function QuoteCalculator({ profileId, rateCardId: initialCardId }) {
  const { pop } = useNav();
  const [selectedCard, setSelectedCard] = useState(null);
  const [form, setForm] = useState({ event_date: '', duration_min: 90, travel_km: 0, overtime_hrs: 0, is_holiday: false });
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const cards = useLoad(() => profileId ? api.get(`/official-profiles/${profileId}/rate-cards`) : Promise.resolve([]), [profileId]);

  useEffect(() => {
    if (cards.data?.length) {
      const initial = initialCardId ? cards.data.find((c) => c.id === initialCardId) : cards.data[0];
      setSelectedCard(initial ?? cards.data[0]);
    }
  }, [cards.data, initialCardId]);

  const calculate = async () => {
    if (!selectedCard) return;
    setBusy(true);
    setErr(null);
    try {
      const result = await api.post(`/official-profiles/${profileId}/rate-cards/${selectedCard.id}/quote`, form);
      setQuote(result);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  // Auto-recalculate when form or card changes
  useEffect(() => {
    if (selectedCard && profileId) calculate();
  }, [selectedCard, form]);

  const cardOpts = (cards.data ?? []).map((c) => ({ value: c.id, label: `${c.sport_emoji ?? '📋'} ${c.name ?? c.sport_name ?? 'Rate card'} · ${money(c.fee_minor, c.fee_currency)}/${c.service_type ?? 'match'}` }));

  if (cards.error) return <Screen><LoadError error={cards.error} onRetry={cards.reload} /></Screen>;
  if (!cards.data) return <Screen><Loading /></Screen>;
  if (!cards.data.length) return <Screen><Empty emoji="📋" title={t('rc.title')} sub={t('rc.onboard_sub')} /></Screen>;

  return (
    <Screen onRefresh={cards.reload} refreshing={cards.loading}>
      <GradCard colors={[c.cyan, c.mint]}>
        <T size={12} weight="800" color="#fff" style={{ letterSpacing: 0.6 }}>📊 {t('rc.breakdown_title').toUpperCase()}</T>
        <T size={24} weight="800" color="#fff" style={{ letterSpacing: -0.8, marginTop: 4 }}>{t('rc.quote_title')}</T>
        <Tag label="📋 Organiser View" color="rgba(255,255,255,0.25)" style={{ marginTop: 6 }} />
      </GradCard>

      <Section title={t('rc.quote_title')} color={c.cyan}>
        <Card>
          <MenuField
            label={t('rc.title')}
            value={selectedCard?.id ?? null}
            onChange={(id) => setSelectedCard(cards.data.find((c) => c.id === id))}
            options={cardOpts}
          />
          {selectedCard ? (
            <View style={{ backgroundColor: c.pinkSoft, borderRadius: 12, padding: 12, gap: 6, marginTop: 8 }}>
              <T weight="700" size={14}>{selectedCard.name ?? selectedCard.sport_name}</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                <Tag label={`${money(selectedCard.fee_minor, selectedCard.fee_currency)}/${selectedCard.service_type ?? 'match'}`} color={c.pinkSoft} />
                {Number(selectedCard.weekend_sat_pct) > 0 ? <Tag label={`+${selectedCard.weekend_sat_pct}% Sat`} color={c.sunSoft} /> : null}
                {selectedCard.tax_inclusive ? <Tag label={t('rc.tax_inclusive')} color={c.mintSoft} /> : null}
              </View>
            </View>
          ) : null}
        </Card>

        <Card>
          <FormSheet inline visible
            initial={form}
            fields={[
              { key: 'event_date', label: t('rc.quote_event_date'), type: 'date', optional: true },
              { key: 'duration_min', label: t('rc.quote_duration'), type: 'stepper', min: 1, max: 2880, step: 15, hint: 'minutes' },
              { key: 'travel_km', label: t('rc.quote_travel'), type: 'stepper', min: 0, max: 10000, step: 5, hint: 'km' },
              { key: 'overtime_hrs', label: t('rc.quote_overtime'), type: 'stepper', min: 0, max: 24, step: 0.5, hint: 'hrs' },
              { key: 'is_holiday', label: t('rc.quote_holiday'), type: 'switch' },
            ]}
            onSubmit={(x) => setForm((f) => ({ ...f, ...x }))}
            onClose={() => {}}
          />
          <Btn title={busy ? t('common.loading') : `🔄 ${t('rc.breakdown_title')}`} onPress={calculate} loading={busy} color={c.cyan} style={{ marginTop: 8 }} accessibilityLabel={t('rc.breakdown_title')} />
        </Card>
      </Section>

      {err ? <T color={c.red} size={13} style={{ margin: 12 }}>{err}</T> : null}

      {quote ? (
        <Section title={t('rc.breakdown_title')} color={c.lime}>
          <Card>
            <T size={12} color={c.mute} style={{ marginBottom: 8 }}>{quote.event_date ?? '—'} · {quote.rate_card_name ?? t('rc.title')}</T>
            {quote.lines.map((line) => (
              <BreakdownLine key={line.key} label={line.label} amount={line.amount} currency={quote.currency}
                style={{ color: line.key === 'base' ? c.ink : line.key === 'premium' ? c.sun : line.key === 'travel' ? c.cyan : c.orange }} />
            ))}

            {/* Subtotal */}
            <View style={{ backgroundColor: c.paper, borderRadius: 10, padding: 10, marginVertical: 8, flexDirection: 'row', justifyContent: 'space-between', borderWidth: 1, borderColor: c.line }}>
              <T weight="700" size={14}>{t('rc.breakdown_subtotal')}</T>
              <T weight="800" size={16}>{money(quote.subtotal, quote.currency)}</T>
            </View>

            {/* Tax row */}
            <BreakdownLine label={t('rc.breakdown_tax')} amount={0} currency={quote.currency}
              style={{ color: c.lime }} />

            {/* Deposit */}
            {quote.deposit_amount > 0 ? (
              <BreakdownLine label={`${t('rc.breakdown_deposit')} (${quote.deposit_type === 'pct' ? `${quote.lines[0]?.amount > 0 ? Math.round(quote.deposit_amount / quote.total * 100) : ''}%` : 'fixed'})`}
                amount={quote.deposit_amount} currency={quote.currency} style={{ color: c.sun }} />
            ) : null}

            {/* Total */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingTop: 12, borderTopWidth: 2, borderTopColor: c.line, marginTop: 4 }}>
              <T weight="800" size={15}>{t('rc.breakdown_total')}</T>
              <T weight="800" size={20} color={c.pink}>{money(quote.total, quote.currency)}</T>
            </View>

            {quote.min_fee_applied ? <T size={11} color={c.orange} style={{ marginTop: 4 }}>* {t('rc.min_fee')} applied</T> : null}
            <T size={11} color={c.mute} style={{ marginTop: 8 }}>{t('rc.breakdown_note')}</T>
          </Card>

          {/* Workflow timeline */}
          <Card>
            <T weight="700" size={14} style={{ marginBottom: 10 }}>📋 Booking Workflow</T>
            {[
              { n: 1, title: 'Request Sent', sub: 'Official notified with estimate details', color: c.cyanSoft },
              { n: 2, title: 'Official Reviews', sub: 'They can confirm, counter-propose or decline', color: c.pinkSoft },
              { n: 3, title: 'Deposit Invoice', sub: `${money(quote.deposit_amount, quote.currency)} due on booking`, color: c.mintSoft },
              { n: 4, title: 'Assignment Confirmed', sub: 'Rate snapshot locked — cannot be edited retroactively', color: c.sunSoft },
            ].map((step) => (
              <View key={step.n} style={{ flexDirection: 'row', gap: 10, marginBottom: 10, alignItems: 'flex-start' }}>
                <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: step.color, alignItems: 'center', justifyContent: 'center' }}>
                  <T size={12} weight="700">{step.n}</T>
                </View>
                <View style={{ flex: 1 }}>
                  <T weight="700" size={13}>{step.title}</T>
                  <T size={12} color={c.mute}>{step.sub}</T>
                </View>
              </View>
            ))}
          </Card>

          <Btn title={`📩 ${t('rc.send_request')}`} color={c.lime} style={{ marginBottom: 8 }}
            onPress={() => { /* navigate to assignment booking flow */ }}
            accessibilityLabel={t('rc.send_request')} />
          <Btn title={`📄 ${t('rc.download_pdf')}`} color={c.paper} ink={c.mute}
            onPress={() => { /* link to documents domain */ }}
            accessibilityLabel={t('rc.download_pdf')} />
        </Section>
      ) : null}
    </Screen>
  );
}
