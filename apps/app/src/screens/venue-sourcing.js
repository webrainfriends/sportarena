// Venue Sourcing Wizard — 4-step Sheet for finding and recording an event venue.
// Step 1: Context (sport, courts, date range, country)
// Step 2: Results (native + external connector cards)
// Step 3: Compare (side-by-side normalised quotes)
// Step 4: Record (manual reference form)
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Chip, Empty, Field, Loading, Row, Sheet, Tag } from '../ui';
import { A, ABtn, ACard, AEmpty, AT, ATag } from '../arena';
import { DateRangeField } from '../pickers';
import { c } from '../theme';
import { t } from '../i18n';
import { moneyIn } from '../vtime';

const STEPS = [
  { key: 'context',  label: t('cc.wiz.step_context') },
  { key: 'results',  label: t('cc.wiz.step_results') },
  { key: 'compare',  label: t('cc.wiz.step_compare') },
  { key: 'record',   label: t('cc.wiz.step_record') },
];

const AVAIL_TAG = {
  live_confirmed:   { label: t('evr.avail.live_confirmed'),  tone: A.green },
  price_indicative: { label: t('evr.avail.price_indicative'),tone: A.sun },
  ballot_pending:   { label: t('evr.avail.ballot_pending'),  tone: A.sun },
  redirect_only:    { label: t('evr.avail.redirect_only'),   tone: A.cyan },
  unknown:          { label: t('evr.avail.unknown'),          tone: A.mute },
  unavailable:      { label: t('evr.avail.unavailable'),      tone: A.red },
};

function StepBar({ current }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12 }}>
      {STEPS.map((s, idx) => {
        const done = STEPS.indexOf(STEPS.find((x) => x.key === current)) > idx;
        const active = s.key === current;
        return (
          <React.Fragment key={s.key}>
            <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
              backgroundColor: active ? A.p2 : done ? A.green : A.panel2 }}>
              <AT size={13} weight="800" color={active || done ? c.on : A.mute}>{done ? '✓' : idx + 1}</AT>
            </View>
            {idx < STEPS.length - 1 ? <View style={{ flex: 1, height: 2, backgroundColor: done ? A.green : A.panel2, marginHorizontal: 4 }} /> : null}
          </React.Fragment>
        );
      })}
    </View>
  );
}

function VenueResultCard({ item, selected, onSelect, onCompare, compareList }) {
  const avail = AVAIL_TAG[item.availability_status ?? 'unknown'] ?? AVAIL_TAG.unknown;
  const inCompare = compareList.some((x) => x.id === item.id);
  const isExternal = item.source === 'external_connector';
  const isLinkout = item.availability_status === 'redirect_only';

  return (
    <Pressable onPress={() => onSelect(item)} accessibilityRole="button" accessibilityLabel={item.name ?? item.external_venue_name}>
      <ACard pad={14} style={{ gap: 10, borderWidth: selected ? 2 : 0, borderColor: selected ? A.p2 : 'transparent' }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <View style={{ flex: 1, gap: 4 }}>
            <AT size={15} weight="800" numberOfLines={2}>{item.name ?? item.external_venue_name}</AT>
            <AT size={12} color={A.mute} numberOfLines={1}>{[item.city ?? item.external_venue_city, item.country ?? item.external_venue_country].filter(Boolean).join(' · ')}</AT>
          </View>
          <View style={{ gap: 6, alignItems: 'flex-end' }}>
            <ATag tone={avail.tone} label={avail.label} />
            {isExternal ? <View style={{ backgroundColor: c.cyanSoft, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}><AT size={11} weight="700" color={c.cyan}>{item.provider_name ?? item.provider_key}</AT></View> : null}
          </View>
        </View>

        {/* Price */}
        {item.hourly_rate_minor || item.price_minor ? (
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <AT size={13} weight="700">{item.currency ?? ''} {((item.hourly_rate_minor ?? item.price_minor ?? 0) / 100).toFixed(2)}<AT size={11} color={A.mute}>{t('cc.per_hour')}</AT></AT>
            {item.courts ? <AT size={13} weight="600" color={A.mute}>{item.courts}{t('cc.courts_avail')}</AT> : null}
          </View>
        ) : null}

        {/* CTAs */}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {isLinkout ? (
            <ABtn small tone="ghost" title={t('cc.open_provider')} onPress={() => onSelect({ ...item, _action: 'linkout' })} />
          ) : (
            <ABtn small title={item.source === 'native' ? t('cc.book_native') : t('cc.book_provider')} onPress={() => onSelect({ ...item, _action: 'book' })} />
          )}
          {!isLinkout ? (
            <ABtn small tone="ghost" title={inCompare ? '✓ ' + t('cc.wiz.in_compare') : t('cc.wiz.add_compare')} onPress={() => onCompare(item)} />
          ) : null}
          <ABtn small tone="ghost" title={t('cc.record_manual')} onPress={() => onSelect({ ...item, _action: 'record' })} />
        </View>
      </ACard>
    </Pressable>
  );
}

function CompareGrid({ items, onBook, onRecord }) {
  if (!items.length) return <AEmpty emoji="⚖️" title={t('cc.wiz.compare_empty')} sub={t('cc.wiz.compare_empty_sub')} />;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ padding: 16, gap: 12, flexDirection: 'row' }}>
      {items.map((q) => (
        <ACard key={q.label ?? q.name} pad={14} style={{ width: 220, gap: 10 }}>
          <AT size={14} weight="800" numberOfLines={2}>{q.venue_name ?? q.name}</AT>
          <ATag tone={(AVAIL_TAG[q.availability_status] ?? AVAIL_TAG.unknown).tone} label={(AVAIL_TAG[q.availability_status] ?? AVAIL_TAG.unknown).label} />

          {/* Per-hour price */}
          <View style={{ gap: 3 }}>
            <AT size={11} weight="600" color={A.mute}>{t('cc.per_hour')}</AT>
            <AT size={18} weight="900">{q.currency} {q.per_hour_minor != null ? ((q.per_hour_minor) / 100).toFixed(2) : '—'}</AT>
          </View>

          {/* Total + tax */}
          {q.total_minor != null ? (
            <AT size={12} color={A.mute}>{t('cc.incl_tax_fee')} {q.currency} {(q.total_minor / 100).toFixed(2)}</AT>
          ) : null}

          {/* Cancellation */}
          {q.cancellation_policy ? <AT size={12} color={A.mute}>{q.cancellation_policy}</AT> : null}

          {/* Warnings */}
          {q.warnings?.length ? q.warnings.map((w) => (
            <View key={w.code} style={{ backgroundColor: A.sunSoft, borderRadius: 8, padding: 8 }}>
              <AT size={11} weight="600" color={A.sun}>⚠ {w.message}</AT>
            </View>
          )) : null}

          <View style={{ gap: 6 }}>
            {q.availability_status !== 'redirect_only' ? <ABtn small title={t('cc.book_provider')} onPress={() => onBook?.(q)} /> : null}
            <ABtn small tone="ghost" title={t('cc.record_manual')} onPress={() => onRecord?.(q)} />
          </View>
        </ACard>
      ))}
    </ScrollView>
  );
}

export function VenueSourcingWizard({ eventId, orgId, eventName, onDone, visible, onClose }) {
  const [step, setStep] = useState('context');

  // Step 1 state
  const [sportKeys, setSportKeys] = useState([]);
  const [courts, setCourts] = useState(1);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [country, setCountry] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');

  // Step 2 state
  const [selected, setSelected] = useState(null);
  const [compareList, setCompareList] = useState([]);

  // Step 3: comparison results (from API)
  const [compareResults, setCompareResults] = useState([]);
  const [comparing, setComparing] = useState(false);

  // Step 4: manual form
  const [venueName, setVenueName] = useState('');
  const [bookingRef, setBookingRef] = useState('');
  const [manualSourceStatus, setManualSourceStatus] = useState('organiser_attested');
  const [saving, setSaving] = useState(false);

  // Options load
  const optParams = useMemo(() => ({
    sport_keys: sportKeys, courts, date_from: dateFrom || undefined, date_to: dateTo || undefined,
    country: country || undefined, source_filter: sourceFilter,
  }), [sportKeys, courts, dateFrom, dateTo, country, sourceFilter]);

  const options = useLoad(
    () => step === 'results' ? api.get(`/events/${eventId}/venue-options`, optParams) : null,
    [step, JSON.stringify(optParams)]);

  const allCards = useMemo(() => {
    if (!options.data) return [];
    return [
      ...(options.data.native_venues ?? []),
      ...(options.data.connector_cards ?? []),
      ...(options.data.existing_reservations ?? []),
    ];
  }, [options.data]);

  const toggleCompare = useCallback((item) => {
    setCompareList((prev) => {
      const id = item.id ?? item.external_venue_id ?? item.name;
      if (prev.some((x) => (x.id ?? x.external_venue_id ?? x.name) === id)) {
        return prev.filter((x) => (x.id ?? x.external_venue_id ?? x.name) !== id);
      }
      if (prev.length >= 4) return prev;
      return [...prev, item];
    });
  }, []);

  const runCompare = async () => {
    if (!compareList.length) return;
    setComparing(true);
    try {
      const quotes = compareList.map((item) => ({
        label: item.name ?? item.external_venue_name ?? item.label,
        source: item.source ?? 'native',
        provider_key: item.provider_key,
        venue_name: item.name ?? item.external_venue_name ?? '',
        venue_city: item.city ?? item.external_venue_city,
        starts_at: dateFrom ? `${dateFrom}T00:00:00Z` : new Date().toISOString(),
        ends_at: dateTo ? `${dateTo}T23:59:00Z` : new Date(Date.now() + 3600000).toISOString(),
        courts,
        price_minor: item.hourly_rate_minor ?? item.price_minor,
        tax_minor: item.tax_minor,
        currency: item.currency ?? 'USD',
        availability_status: item.availability_status,
        cancellation_policy: item.cancellation_policy,
        quote_fetched_at: item.quote_fetched_at,
      }));
      const result = await api.post(`/events/${eventId}/venue-quotes/compare`, { quotes });
      setCompareResults(Array.isArray(result) ? result : []);
      setStep('compare');
    } catch (x) {
      setCompareResults([]);
    } finally {
      setComparing(false);
    }
  };

  const saveManual = async () => {
    if (!venueName.trim()) return;
    setSaving(true);
    try {
      await api.post(`/events/${eventId}/external-venue-reservations`, {
        provider_key: selected?.provider_key ?? 'manual',
        external_venue_name: venueName.trim(),
        external_booking_reference: bookingRef.trim() || undefined,
        source_status: manualSourceStatus,
        venue_source: 'external_manual',
        status: bookingRef.trim() ? 'awaiting_confirmation' : 'draft',
        starts_at: dateFrom ? `${dateFrom}T00:00:00Z` : undefined,
        ends_at: dateTo ? `${dateTo}T23:59:00Z` : undefined,
        sport_keys: sportKeys,
        courts_requested: courts,
      });
      onDone?.();
      onClose?.();
    } catch (x) {
      // bubble error to toast in parent
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setStep('context'); setSelected(null); setCompareList([]); setCompareResults([]);
    setVenueName(''); setBookingRef(''); setSaving(false);
  };

  const SOURCE_OPTIONS = [
    { key: 'all', label: t('cc.wiz.src_all') },
    { key: 'native', label: t('cc.wiz.src_native') },
    { key: 'external_connector', label: t('cc.wiz.src_connector') },
    { key: 'external_manual', label: t('cc.wiz.src_manual') },
  ];

  const SOURCE_STATUS_OPTIONS = [
    { key: 'organiser_attested', label: t('evr.source_status.organiser_attested') },
    { key: 'provider_confirmed', label: t('evr.source_status.provider_confirmed') },
    { key: 'unverified_linkout', label: t('evr.source_status.unverified_linkout') },
  ];

  return (
    <Sheet visible={visible} onClose={() => { reset(); onClose?.(); }} title={t('cc.wiz.title')} subtitle={eventName}>
      <StepBar current={step} />

      {/* Step 1: Context */}
      {step === 'context' ? (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
          <AT size={18} weight="800">{t('cc.wiz.context_title')}</AT>

          {/* Courts counter */}
          <View>
            <AT size={13} weight="700" color={A.mute} style={{ marginBottom: 6 }}>{t('cc.wiz.courts_label')}</AT>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
              <ABtn small tone="ghost" title="−" onPress={() => setCourts(Math.max(1, courts - 1))} />
              <AT size={22} weight="900">{courts}</AT>
              <ABtn small tone="ghost" title="+" onPress={() => setCourts(courts + 1)} />
            </View>
          </View>

          {/* Date range */}
          <View>
            <AT size={13} weight="700" color={A.mute} style={{ marginBottom: 6 }}>{t('cc.wiz.dates_label')}</AT>
            <DateRangeField value={{ from: dateFrom, to: dateTo }} onChange={({ from, to }) => { setDateFrom(from ?? ''); setDateTo(to ?? ''); }} />
          </View>

          {/* Country chips */}
          <View>
            <AT size={13} weight="700" color={A.mute} style={{ marginBottom: 8 }}>{t('cc.wiz.country_label')}</AT>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {[{ key: '', label: '🌐 Any' }, { key: 'SG', label: '🇸🇬 Singapore' }, { key: 'IN', label: '🇮🇳 India' }, { key: 'AU', label: '🇦🇺 Australia' }].map((opt) => (
                <Pressable key={opt.key} onPress={() => setCountry(opt.key)} accessibilityRole="radio" accessibilityState={{ selected: country === opt.key }}
                  style={{ backgroundColor: country === opt.key ? A.p2 : c.line, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 }}>
                  <AT size={13} weight="700" color={country === opt.key ? c.on : A.ink}>{opt.label}</AT>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Source filter */}
          <View>
            <AT size={13} weight="700" color={A.mute} style={{ marginBottom: 8 }}>{t('cc.wiz.source_label')}</AT>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {SOURCE_OPTIONS.map((opt) => (
                <Pressable key={opt.key} onPress={() => setSourceFilter(opt.key)} accessibilityRole="radio" accessibilityState={{ selected: sourceFilter === opt.key }}
                  style={{ backgroundColor: sourceFilter === opt.key ? A.p2 : c.line, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 }}>
                  <AT size={13} weight="700" color={sourceFilter === opt.key ? c.on : A.ink}>{opt.label}</AT>
                </Pressable>
              ))}
            </View>
          </View>

          <ABtn title={t('cc.wiz.search_cta')} onPress={() => setStep('results')} />
        </ScrollView>
      ) : null}

      {/* Step 2: Results */}
      {step === 'results' ? (
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 10 }}>
            <ABtn small tone="ghost" title="← Back" onPress={() => setStep('context')} />
            <AT size={14} weight="700" style={{ flex: 1 }}>{t('cc.wiz.results_title')}</AT>
            {compareList.length >= 2 ? (
              <ABtn small title={comparing ? '…' : `⚖ ${t('cc.wiz.compare_cta')} (${compareList.length})`} onPress={runCompare} />
            ) : null}
          </View>
          {options.loading ? <Loading /> : !allCards.length ? (
            <AEmpty emoji="🏟️" title={t('cc.empty_title')} sub={t('cc.wiz.no_results')} />
          ) : (
            <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
              {allCards.map((item, idx) => (
                <VenueResultCard key={item.id ?? idx} item={item} selected={selected?.id === item.id} onSelect={(it) => { setSelected(it); if (it._action === 'record') setStep('record'); }} onCompare={toggleCompare} compareList={compareList} />
              ))}
            </ScrollView>
          )}
        </View>
      ) : null}

      {/* Step 3: Compare */}
      {step === 'compare' ? (
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 10 }}>
            <ABtn small tone="ghost" title="← Back" onPress={() => setStep('results')} />
            <AT size={14} weight="700" style={{ flex: 1 }}>{t('cc.wiz.compare_title')}</AT>
          </View>
          <CompareGrid items={compareResults} onBook={(q) => { setSelected(q); setStep('record'); }} onRecord={(q) => { setVenueName(q.venue_name ?? ''); setSelected(q); setStep('record'); }} />
        </View>
      ) : null}

      {/* Step 4: Record */}
      {step === 'record' ? (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <ABtn small tone="ghost" title="← Back" onPress={() => setStep('results')} />
            <AT size={18} weight="800" style={{ flex: 1 }}>{t('evr.record_title')}</AT>
          </View>

          <Field label={t('evr.venue_name_label')} placeholder={t('evr.venue_name_hint')} value={venueName} onChangeText={setVenueName} accessibilityLabel={t('evr.venue_name_label')} />
          <Field label={t('evr.booking_reference_label')} placeholder={t('evr.booking_reference_hint')} value={bookingRef} onChangeText={setBookingRef} accessibilityLabel={t('evr.booking_reference_label')} />

          {/* Source status chips */}
          <View>
            <AT size={13} weight="700" color={A.mute} style={{ marginBottom: 8 }}>{t('evr.source_status_label')}</AT>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {SOURCE_STATUS_OPTIONS.map((opt) => (
                <Pressable key={opt.key} onPress={() => setManualSourceStatus(opt.key)} accessibilityRole="radio" accessibilityState={{ selected: manualSourceStatus === opt.key }}
                  style={{ backgroundColor: manualSourceStatus === opt.key ? A.p2 : c.line, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 }}>
                  <AT size={13} weight="700" color={manualSourceStatus === opt.key ? c.on : A.ink}>{opt.label}</AT>
                </Pressable>
              ))}
            </View>
          </View>

          <ABtn title={saving ? '…' : t('evr.save_cta')} onPress={saveManual} disabled={saving || !venueName.trim()} />
        </ScrollView>
      ) : null}
    </Sheet>
  );
}
