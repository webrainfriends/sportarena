// Officials Services & Opportunity Marketplace (Issue #1003, REF-R11)
// Two root views:
//   OfficialServicesHub — the official's service management dashboard (access from officials-home)
//   FindOfficialsHub    — the organiser's official discovery experience (access from event console)
// The engagement lifecycle (quote → contract → invoice → pay) reuses MarketplaceEngagement.
import React, { useState, useCallback } from 'react';
import { View, Pressable, ScrollView, FlatList } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useNav } from '../nav';
import { useSession } from '../session';
import { useLayout } from '../layout';
import { Btn, Card, Chip, Empty, Field, GradCard, H1, Loading, Screen, Section, Seg, Sheet, T, Tag } from '../ui';
import { FormSheet } from '../FormSheet';
import { MenuField, MultiMenuField } from '../pickers';
import { DateField, TimeField } from '../pickers';
import { money } from '../federation-ui';
import { c, grad, r } from '../theme';
import { t } from '../i18n';
import { StatusTag } from './marketplace-hub';
import { explain, LoadError } from '../access';

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const ROLES = [
  { value: 'referee', label: 'Referee' },
  { value: 'umpire', label: 'Umpire' },
  { value: 'linesman', label: 'Asst. Referee' },
  { value: 'fourth_official', label: '4th Official' },
  { value: 'video_assistant_referee', label: 'VAR' },
  { value: 'reserve_assistant_referee', label: 'Reserve AR' },
  { value: 'scorer', label: 'Scorer' },
  { value: 'timekeeper', label: 'Timekeeper' },
  { value: 'goal_line_official', label: 'Goal Line' },
  { value: 'technical_official', label: 'Technical' },
  { value: 'shot_clock_operator', label: 'Shot Clock' },
];
const EVENT_TYPES = [
  { value: 'league', label: 'League' },
  { value: 'cup', label: 'Cup / Knockout' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'tournament', label: 'Tournament' },
  { value: 'international', label: 'International' },
  { value: 'school', label: 'School' },
  { value: 'university', label: 'University' },
  { value: 'amateur', label: 'Amateur / Recreational' },
  { value: 'corporate', label: 'Corporate' },
  { value: 'volunteer', label: 'Volunteer' },
];
const EQUIPMENT = [
  { value: 'whistle', label: '🎺 Whistle' },
  { value: 'flag_set', label: '🚩 Flag set' },
  { value: 'vanishing_spray', label: '🟡 Vanishing spray' },
  { value: 'board', label: '🪧 Board' },
  { value: 'timing_equipment', label: '⏱ Timing equipment' },
  { value: 'uniform_formal', label: '👔 Formal uniform' },
  { value: 'uniform_casual', label: '👕 Casual uniform' },
  { value: 'kit_bag', label: '🎒 Kit bag' },
  { value: 'comms_headset', label: '🎧 Comms headset' },
];
const CRED_TONE = { verified: c.mintSoft, pending: c.cyanSoft, expiring: c.sunSoft, expired: c.sunSoft, revoked: c.sunSoft, self_declared: c.paper, none: c.paper };
const CRED_LABEL = { verified: '✅ Verified', pending: '⏳ Pending', expiring: '⚠️ Expiring soon', expired: '⛔ Expired', revoked: '⛔ Revoked', self_declared: 'Self-declared', none: 'No credential' };

const credTag = (state) => <Tag label={CRED_LABEL[state] ?? state} color={CRED_TONE[state] ?? c.paper} />;
const roleChips = (roles = []) => roles.map((r) => <Tag key={r} label={ROLES.find((x) => x.value === r)?.label ?? r} color={c.violetSoft} />);
const stars = (rating, count) => (
  <T size={13} color={c.mute}>{'★'.repeat(Math.round(rating ?? 0))}{'☆'.repeat(5 - Math.round(rating ?? 0))} {rating ? `${Number(rating).toFixed(1)} (${count ?? 0})` : t('officials.svc.no_reviews')}</T>
);

// ─────────────────────────────────────────────────────────────────────────────
// OfficialCard — shared between FindOfficialsHub listing and shortlist
// ─────────────────────────────────────────────────────────────────────────────

function OfficialCard({ item, onRequest, onDetail, shortlisted, onShortlist }) {
  return (
    <Card onPress={() => onDetail(item)} accessibilityLabel={`${item.display_name}, ${item.roles?.join(', ')}, ${item.credential_state}`}>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
        {item.avatar_url ? (
          <View style={{ width: 52, height: 52, borderRadius: 26, overflow: 'hidden', backgroundColor: c.line }}>
            {/* Avatar image component if available */}
          </View>
        ) : (
          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
            <T size={22}>🧑‍⚖️</T>
          </View>
        )}
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <T weight="800" size={15.5}>{item.display_name}</T>
            {credTag(item.credential_state)}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
            {roleChips(item.roles?.slice(0, 3))}
            {(item.grades ?? []).slice(0, 2).map((g) => <Tag key={g} label={g} color={c.cyanSoft} />)}
          </View>
          {stars(item.rating, item.rating_count)}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
            {(item.event_types ?? []).slice(0, 3).map((et) => <Tag key={et} label={EVENT_TYPES.find((x) => x.value === et)?.label ?? et} color={c.limeSoft} />)}
          </View>
        </View>
        <View style={{ gap: 6, alignItems: 'flex-end' }}>
          {item.rate_minor != null ? (
            <T size={13} weight="700" color={c.pink}>{money(item.rate_minor, item.rate_currency)}/{item.rate_unit ?? 'match'}</T>
          ) : item.volunteer_available ? <Tag label={t('officials.svc.listing.volunteer')} color={c.limeSoft} /> : null}
          <Pressable
            onPress={() => onShortlist(item)}
            accessibilityLabel={shortlisted ? t('officials.svc.unsave') : t('officials.svc.save')}
            hitSlop={12}
          >
            <T size={22}>{shortlisted ? '❤️' : '🤍'}</T>
          </Pressable>
        </View>
      </View>
      {item.headline ? <T size={13} color={c.mute} style={{ marginTop: 6 }}>{item.headline}</T> : null}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
        <Btn
          title={t('officials.svc.request.cta')}
          onPress={() => onRequest(item)}
          style={{ flex: 1, minHeight: 44 }}
          accessibilityLabel={`${t('officials.svc.request.cta')} ${item.display_name}`}
        />
      </View>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OfficialListingWizard — 6-step wizard for the official to publish their listing
// ─────────────────────────────────────────────────────────────────────────────

const STEPS = [
  { id: 'sports_roles',  label: t('officials.svc.wiz.step_sports_roles') },
  { id: 'grades',        label: t('officials.svc.wiz.step_grades') },
  { id: 'event_types',   label: t('officials.svc.wiz.step_event_types') },
  { id: 'equipment',     label: t('officials.svc.wiz.step_equipment') },
  { id: 'travel',        label: t('officials.svc.wiz.step_travel') },
  { id: 'preview',       label: t('officials.svc.wiz.step_preview') },
];

function OfficialListingWizard({ visible, onClose, existing, sports, onSaved }) {
  const { toast } = useSession();
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    headline: existing?.headline ?? '',
    summary: existing?.summary ?? '',
    roles: existing?.roles ?? [],
    grades: existing?.grades ?? [],
    event_types: existing?.event_types ?? [],
    equipment_own: existing?.equipment_own ?? [],
    max_travel_km: existing?.max_travel_km ?? '',
    insurance_valid_until: existing?.insurance_valid_until ?? '',
    volunteer_available: existing?.volunteer_available ?? false,
    rate_minor: existing?.rate_minor != null ? String(Math.round(existing.rate_minor / 100)) : '',
    rate_currency: existing?.rate_currency ?? 'INR',
    rate_unit: existing?.rate_unit ?? 'match',
    remote: existing?.remote ?? false,
    locations: (existing?.locations ?? []).join(', '),
  });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.roles.length) return toast(t('officials.svc.wiz.roles_required'));
    if (!form.headline.trim()) return toast(t('officials.svc.wiz.headline_required'));
    setSaving(true);
    try {
      await api.put('/me/official-service-listing', {
        headline: form.headline.trim(),
        summary: form.summary.trim() || undefined,
        roles: form.roles,
        grades: form.grades,
        event_types: form.event_types,
        equipment_own: form.equipment_own,
        max_travel_km: form.max_travel_km ? Number(form.max_travel_km) : undefined,
        insurance_valid_until: form.insurance_valid_until || undefined,
        volunteer_available: form.volunteer_available,
        rate_minor: form.rate_minor ? Math.round(Number(form.rate_minor) * 100) : undefined,
        rate_currency: form.rate_currency,
        rate_unit: form.rate_unit,
        remote: form.remote,
        locations: form.locations ? form.locations.split(',').map((s) => s.trim()).filter(Boolean) : [],
      });
      toast(t('officials.svc.listing.saved'));
      onSaved();
      onClose();
    } catch (e) {
      toast(explain(e));
    } finally {
      setSaving(false);
    }
  };

  const stepContent = () => {
    switch (STEPS[step].id) {
      case 'sports_roles':
        return (
          <View style={{ gap: 14 }}>
            <T weight="800" size={17}>{t('officials.svc.wiz.headline_label')}</T>
            <Field label={t('officials.svc.listing.headline')} value={form.headline} onChangeText={(v) => set('headline', v)} placeholder={t('officials.svc.listing.headline_hint')} maxLength={140} />
            <Field label={t('officials.svc.listing.summary')} value={form.summary} onChangeText={(v) => set('summary', v)} multiline placeholder={t('officials.svc.listing.summary_hint')} maxLength={1000} />
            <T weight="800" size={15}>{t('officials.svc.listing.roles')}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {ROLES.map((ro) => (
                <Chip
                  key={ro.value}
                  label={ro.label}
                  selected={form.roles.includes(ro.value)}
                  onPress={() => set('roles', form.roles.includes(ro.value) ? form.roles.filter((r) => r !== ro.value) : [...form.roles, ro.value])}
                  accessibilityLabel={ro.label}
                />
              ))}
            </View>
          </View>
        );
      case 'grades':
        return (
          <View style={{ gap: 14 }}>
            <T color={c.mute} size={13}>{t('officials.svc.wiz.grades_hint')}</T>
            <Field
              label={t('officials.svc.listing.grades')}
              value={form.grades.join(', ')}
              onChangeText={(v) => set('grades', v.split(',').map((s) => s.trim()).filter(Boolean))}
              placeholder={t('officials.svc.listing.grades_hint')}
              multiline
            />
          </View>
        );
      case 'event_types':
        return (
          <View style={{ gap: 14 }}>
            <T weight="800" size={15}>{t('officials.svc.listing.event_types')}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {EVENT_TYPES.map((et) => (
                <Chip
                  key={et.value}
                  label={et.label}
                  selected={form.event_types.includes(et.value)}
                  onPress={() => set('event_types', form.event_types.includes(et.value) ? form.event_types.filter((x) => x !== et.value) : [...form.event_types, et.value])}
                  accessibilityLabel={et.label}
                />
              ))}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <Chip
                label={t('officials.svc.listing.volunteer_available')}
                selected={form.volunteer_available}
                onPress={() => set('volunteer_available', !form.volunteer_available)}
                accessibilityLabel={t('officials.svc.listing.volunteer_available')}
              />
            </View>
          </View>
        );
      case 'equipment':
        return (
          <View style={{ gap: 14 }}>
            <T weight="800" size={15}>{t('officials.svc.listing.equipment')}</T>
            <T color={c.mute} size={13}>{t('officials.svc.wiz.equipment_hint')}</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {EQUIPMENT.map((eq) => (
                <Chip
                  key={eq.value}
                  label={eq.label}
                  selected={form.equipment_own.includes(eq.value)}
                  onPress={() => set('equipment_own', form.equipment_own.includes(eq.value) ? form.equipment_own.filter((x) => x !== eq.value) : [...form.equipment_own, eq.value])}
                  accessibilityLabel={eq.label}
                />
              ))}
            </View>
          </View>
        );
      case 'travel':
        return (
          <View style={{ gap: 14 }}>
            <Field label={t('officials.svc.listing.rate_label')} value={form.rate_minor} onChangeText={(v) => set('rate_minor', v)} keyboardType="decimal-pad" placeholder="0" />
            <Field label={t('officials.svc.listing.rate_unit')} value={form.rate_unit} onChangeText={(v) => set('rate_unit', v)} placeholder="match" />
            <Field label={t('officials.svc.listing.max_travel_km')} value={String(form.max_travel_km)} onChangeText={(v) => set('max_travel_km', v)} keyboardType="number-pad" placeholder={t('officials.svc.listing.max_travel_hint')} />
            <Field label={t('officials.svc.listing.insurance_until')} value={form.insurance_valid_until} onChangeText={(v) => set('insurance_valid_until', v)} placeholder="YYYY-MM-DD" />
            <Field label={t('officials.svc.listing.locations')} value={form.locations} onChangeText={(v) => set('locations', v)} placeholder={t('officials.svc.listing.locations_hint')} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Chip label={t('officials.svc.listing.remote')} selected={form.remote} onPress={() => set('remote', !form.remote)} accessibilityLabel={t('officials.svc.listing.remote')} />
            </View>
          </View>
        );
      case 'preview':
        return (
          <View style={{ gap: 14 }}>
            <T weight="800" size={17}>{t('officials.svc.wiz.preview_title')}</T>
            <Card pad={16}>
              <T weight="800" size={16}>{form.headline || t('officials.svc.listing.headline_hint')}</T>
              {form.summary ? <T size={13} color={c.mute} style={{ marginTop: 4 }}>{form.summary}</T> : null}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {roleChips(form.roles)}
                {form.grades.slice(0, 2).map((g) => <Tag key={g} label={g} color={c.cyanSoft} />)}
              </View>
              {form.rate_minor ? <T size={13} weight="700" color={c.pink} style={{ marginTop: 6 }}>{money(Math.round(Number(form.rate_minor) * 100), form.rate_currency)}/{form.rate_unit}</T> : null}
              {form.volunteer_available ? <Tag label={t('officials.svc.listing.volunteer')} color={c.limeSoft} style={{ marginTop: 4 }} /> : null}
            </Card>
            <T color={c.mute} size={12}>{t('officials.svc.wiz.preview_note')}</T>
          </View>
        );
      default: return null;
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={t('officials.svc.wiz.title')} accessibilityLabel={t('officials.svc.wiz.title')}>
      <View style={{ gap: 6, marginBottom: 16 }}>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {STEPS.map((s, idx) => (
            <View key={s.id} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: idx <= step ? c.pink : c.line }} />
          ))}
        </View>
        <T size={12} color={c.mute}>{t('officials.svc.wiz.step_n_of', { n: step + 1, total: STEPS.length })} · {STEPS[step].label}</T>
      </View>
      <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 500 }}>
        {stepContent()}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        {step > 0 && <Btn title={t('common.back')} onPress={() => setStep((s) => s - 1)} color={c.paper} ink={c.ink} style={{ flex: 1, minHeight: 48 }} />}
        {step < STEPS.length - 1 ? (
          <Btn title={t('common.next')} onPress={() => setStep((s) => s + 1)} style={{ flex: 1, minHeight: 48 }} />
        ) : (
          <Btn title={t('officials.svc.wiz.publish')} onPress={save} loading={saving} style={{ flex: 1, minHeight: 48 }} accessibilityLabel={t('officials.svc.wiz.publish')} />
        )}
      </View>
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OfficialServicesHub — the official's service management view
// ─────────────────────────────────────────────────────────────────────────────

export function OfficialServicesHub() {
  const { go } = useNav();
  const { toast } = useSession();
  const { wide } = useLayout();
  const [showWizard, setShowWizard] = useState(false);
  const [tab, setTab] = useState('listing');
  const { data, loading, error, reload } = useLoad('/me/official-service-listing');
  const { data: opp, reload: reloadOpp } = useLoad('/me/official-opportunities');

  const listing = data?.listing;
  const metrics = data?.metrics ?? {};
  const incoming = data?.incoming ?? [];
  const opportunities = opp?.opportunities ?? [];

  const setListingState = async (state) => {
    try {
      await api.patch('/me/official-service-listing/state', { state });
      toast(state === 'paused' ? t('officials.svc.listing.paused') : t('officials.svc.listing.resumed'));
      reload();
    } catch (e) { toast(explain(e)); }
  };

  if (loading) return <Loading />;
  if (error) return <LoadError onRetry={reload} />;

  return (
    <Screen title={t('officials.svc.title')} subtitle={t('officials.svc.subtitle')}>
      <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 32 }}>
        {/* Metric strip */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {[
            [t('officials.svc.metric.views'), metrics.views_month ?? 0],
            [t('officials.svc.metric.shortlists'), metrics.shortlists ?? 0],
            [t('officials.svc.metric.bookings'), metrics.active_bookings ?? 0],
            [t('officials.svc.metric.earned_mtd'), metrics.earned_mtd != null ? money(metrics.earned_mtd, listing?.rate_currency) : '—'],
          ].map(([label, val]) => (
            <Card key={label} pad={12} style={{ flex: 1, minWidth: 80, alignItems: 'center' }}>
              <T weight="800" size={18} color={c.pink}>{val}</T>
              <T size={11} color={c.mute} style={{ textAlign: 'center' }}>{label}</T>
            </Card>
          ))}
        </View>

        {/* Listing status card */}
        <GradCard colors={grad.hero}>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T weight="800" size={17} color="#fff">{t('officials.svc.listing.title')}</T>
              {listing ? (
                <Tag label={listing.status === 'active' ? t('officials.svc.listing.published') : t('officials.svc.listing.paused')} color={listing.status === 'active' ? '#1a9e5c' : '#9b7200'} />
              ) : (
                <Tag label={t('officials.svc.listing.draft')} color={c.line} />
              )}
            </View>
            {listing ? (
              <T color="rgba(255,255,255,0.85)" size={13}>{listing.headline}</T>
            ) : (
              <T color="rgba(255,255,255,0.75)" size={13}>{t('officials.svc.listing.empty')}</T>
            )}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
              <Btn title={listing ? t('officials.svc.listing.edit') : t('officials.svc.listing.create')} onPress={() => setShowWizard(true)} style={{ flex: 1, minHeight: 48 }} accessibilityLabel={listing ? t('officials.svc.listing.edit') : t('officials.svc.listing.create')} />
              {listing ? (
                listing.status === 'active' ? (
                  <Btn title={t('officials.svc.listing.pause')} onPress={() => setListingState('paused')} color="rgba(255,255,255,0.15)" ink="#fff" style={{ flex: 1, minHeight: 48 }} />
                ) : (
                  <Btn title={t('officials.svc.listing.resume')} onPress={() => setListingState('active')} color="rgba(255,255,255,0.15)" ink="#fff" style={{ flex: 1, minHeight: 48 }} />
                )
              ) : null}
            </View>
          </View>
        </GradCard>

        <Seg tabs={[t('officials.svc.tab.listing'), t('officials.svc.tab.requests'), t('officials.svc.tab.opportunities')]} selected={tab} onSelect={(idx) => setTab(['listing','requests','opportunities'][idx])} />

        {tab === 'listing' && listing && (
          <Section title={t('officials.svc.listing.details')}>
            <Card pad={14}>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>{roleChips(listing.roles)}</View>
                {listing.grades?.length ? <T size={13} color={c.mute}>{t('officials.svc.listing.grades')}: {listing.grades.join(' · ')}</T> : null}
                {listing.event_types?.length ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                    {listing.event_types.map((et) => <Tag key={et} label={EVENT_TYPES.find((x) => x.value === et)?.label ?? et} color={c.limeSoft} />)}
                  </View>
                ) : null}
                {listing.equipment_own?.length ? (
                  <T size={12} color={c.mute}>{t('officials.svc.listing.equipment')}: {listing.equipment_own.map((e) => EQUIPMENT.find((x) => x.value === e)?.label ?? e).join(', ')}</T>
                ) : null}
                {listing.max_travel_km ? <T size={12} color={c.mute}>{t('officials.svc.listing.max_travel_km')}: {listing.max_travel_km} km</T> : null}
                {listing.volunteer_available ? <Tag label={t('officials.svc.listing.volunteer')} color={c.limeSoft} /> : null}
              </View>
            </Card>
          </Section>
        )}

        {tab === 'requests' && (
          <Section title={`${t('officials.svc.incoming_requests')}${incoming.length ? ` (${incoming.length})` : ''}`}>
            {incoming.length ? incoming.map((e) => (
              <Card key={e.id} onPress={() => go('MarketplaceEngagement', { id: e.id })} accessibilityLabel={`${e.title}, ${e.buyer_name}, ${e.engagement_status}`} style={{ marginBottom: 8 }}>
                <View style={{ gap: 4 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <T weight="800" size={14.5}>{e.title}</T>
                    <StatusTag status={e.engagement_status} />
                  </View>
                  <T size={13} color={c.mute}>{e.buyer_name}{e.sport_name ? ` · ${e.sport_name}` : ''}</T>
                  {e.budget_minor != null ? <T size={13} weight="600" color={c.pink}>{money(e.budget_minor, e.currency)}</T> : null}
                  <T size={12} color={c.mute}>{new Date(e.created_at).toLocaleDateString()}</T>
                </View>
              </Card>
            )) : <Empty emoji="📭" title={t('officials.svc.no_requests')} sub={t('officials.svc.no_requests_sub')} />}
          </Section>
        )}

        {tab === 'opportunities' && (
          <Section title={t('officials.svc.opp.title')}>
            {opportunities.length ? opportunities.map((p) => (
              <Card key={p.id} style={{ marginBottom: 8 }} accessibilityLabel={`${p.title}, ${p.poster_name}, ${p.sport_name ?? ''}`}>
                <View style={{ gap: 4 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <T weight="800" size={14.5}>{p.title}</T>
                    {p.relevance_match ? <Tag label={t('officials.svc.opp.relevant')} color={c.mintSoft} /> : null}
                    {p.already_responded ? <Tag label={t('officials.svc.opp.responded')} color={c.pinkSoft} /> : null}
                  </View>
                  <T size={13} color={c.mute}>{p.poster_name}{p.sport_name ? ` · ${p.sport_emoji} ${p.sport_name}` : ''}</T>
                  {p.budget_cents != null ? <T size={13} weight="600" color={c.pink}>{money(p.budget_cents, p.currency)}</T> : null}
                  {!p.already_responded && (
                    <Btn title={t('officials.svc.opp.respond')} onPress={() => go('Marketplace', { postId: p.id })} style={{ marginTop: 6, minHeight: 44 }} />
                  )}
                </View>
              </Card>
            )) : <Empty emoji="📋" title={t('officials.svc.opp.empty')} sub={t('officials.svc.opp.empty_sub')} />}
          </Section>
        )}
      </ScrollView>

      {showWizard && (
        <OfficialListingWizard
          visible={showWizard}
          onClose={() => setShowWizard(false)}
          existing={listing}
          onSaved={reload}
        />
      )}
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OfficialServiceDetail — full official profile modal
// ─────────────────────────────────────────────────────────────────────────────

function OfficialServiceDetail({ listing, onClose, onRequest }) {
  const { data, loading } = useLoad(listing ? `/official-services/${listing.id}` : null);
  const detail = data ?? listing;
  return (
    <Sheet visible={!!listing} onClose={onClose} title={detail?.display_name ?? ''} accessibilityLabel={detail?.display_name ?? ''}>
      <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 600 }}>
        {loading ? <Loading /> : (
          <View style={{ gap: 14 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {credTag(detail?.credential_state)}
              {roleChips(detail?.roles ?? [])}
            </View>
            {stars(detail?.rating, detail?.rating_count)}
            {detail?.headline ? <T size={14} style={{ marginTop: 4 }}>{detail.headline}</T> : null}
            {detail?.summary ? <T size={13} color={c.mute}>{detail.summary}</T> : null}
            {/* Grades */}
            {detail?.grades?.length ? (
              <View style={{ gap: 4 }}>
                <T weight="700" size={13}>{t('officials.svc.listing.grades')}</T>
                <T size={13} color={c.mute}>{detail.grades.join(' · ')}</T>
              </View>
            ) : null}
            {/* Event types */}
            {detail?.event_types?.length ? (
              <View style={{ gap: 4 }}>
                <T weight="700" size={13}>{t('officials.svc.listing.event_types')}</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                  {detail.event_types.map((et) => <Tag key={et} label={EVENT_TYPES.find((x) => x.value === et)?.label ?? et} color={c.limeSoft} />)}
                </View>
              </View>
            ) : null}
            {/* Rate cards */}
            {data?.rate_cards?.length ? (
              <View style={{ gap: 4 }}>
                <T weight="700" size={13}>{t('officials.svc.rate_cards')}</T>
                {data.rate_cards.map((rc, i) => (
                  <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: c.line }}>
                    <T size={13}>{ROLES.find((r) => r.value === rc.role)?.label ?? rc.role}{rc.fixture_type ? ` · ${rc.fixture_type}` : ''}</T>
                    <T size={13} weight="700" color={c.pink}>{money(rc.fee_minor, rc.fee_currency)}/{rc.rate_unit ?? 'match'}</T>
                  </View>
                ))}
              </View>
            ) : null}
            {/* Equipment */}
            {detail?.equipment_own?.length ? (
              <T size={12} color={c.mute}>{t('officials.svc.listing.equipment')}: {detail.equipment_own.map((e) => EQUIPMENT.find((x) => x.value === e)?.label ?? e).join(', ')}</T>
            ) : null}
            {/* Travel */}
            {detail?.max_travel_km ? <T size={12} color={c.mute}>{t('officials.svc.listing.max_travel_km')}: {detail.max_travel_km} km</T> : null}
            {/* Recent reviews */}
            {data?.recent_reviews?.length ? (
              <View style={{ gap: 6 }}>
                <T weight="700" size={13}>{t('officials.svc.reviews')}</T>
                {data.recent_reviews.slice(0, 3).map((rv, i) => (
                  <Card key={i} pad={10}>
                    <T size={12} weight="700" color={c.pink}>{Number(rv.overall).toFixed(1)}/5.0</T>
                    {rv.public_note ? <T size={12} color={c.mute} style={{ marginTop: 2 }}>{rv.public_note}</T> : null}
                  </Card>
                ))}
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>
      <Btn title={t('officials.svc.request.cta')} onPress={() => { onClose(); onRequest(listing); }} style={{ marginTop: 14, minHeight: 52 }} accessibilityLabel={t('officials.svc.request.cta')} />
    </Sheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OfficialRequestSheet — organiser sends a booking request
// ─────────────────────────────────────────────────────────────────────────────

function OfficialRequestSheet({ official, visible, onClose, onSent, sports }) {
  const { toast } = useSession();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ title: '', brief: '', sport: '', role_wanted: official?.roles?.[0] ?? '', event_date: '', budget: '' });
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const send = async () => {
    if (!form.title.trim()) return toast(t('officials.svc.request.title_required'));
    setSaving(true);
    try {
      const res = await api.post(`/official-services/${official.id}/request`, {
        title: form.title.trim(),
        brief: form.brief.trim() || undefined,
        sport: form.sport || undefined,
        role_wanted: form.role_wanted || undefined,
        event_date: form.event_date || undefined,
        budget_minor: form.budget ? Math.round(Number(form.budget) * 100) : undefined,
      });
      toast(t('officials.svc.request.sent'));
      onSent?.(res.engagement_id);
      onClose();
    } catch (e) {
      toast(explain(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormSheet visible={visible} onClose={onClose} title={t('officials.svc.request.sheet_title', { name: official?.display_name ?? '' })} accessibilityLabel={t('officials.svc.request.sheet_title', { name: official?.display_name ?? '' })}>
      <View style={{ gap: 14 }}>
        <Field label={t('officials.svc.request.title_label')} value={form.title} onChangeText={(v) => set('title', v)} placeholder={t('officials.svc.request.title_hint')} maxLength={140} />
        <Field label={t('officials.svc.request.brief_label')} value={form.brief} onChangeText={(v) => set('brief', v)} multiline placeholder={t('officials.svc.request.brief_hint')} maxLength={2000} />
        {sports?.length ? (
          <MenuField label={t('officials.svc.request.sport_label')} value={form.sport} options={sports.map((s) => ({ value: s.slug, label: s.name }))} onSelect={(v) => set('sport', v)} placeholder={t('officials.svc.request.sport_hint')} />
        ) : null}
        <MenuField label={t('officials.svc.request.role_label')} value={form.role_wanted} options={ROLES} onSelect={(v) => set('role_wanted', v)} placeholder={t('officials.svc.request.role_hint')} />
        <Field label={t('officials.svc.request.date_label')} value={form.event_date} onChangeText={(v) => set('event_date', v)} placeholder="YYYY-MM-DD" keyboardType="numeric" />
        <Field label={t('officials.svc.request.budget_label')} value={form.budget} onChangeText={(v) => set('budget', v)} keyboardType="decimal-pad" placeholder={t('officials.svc.request.budget_hint')} />
      </View>
      <Btn title={t('officials.svc.request.send_cta')} onPress={send} loading={saving} style={{ marginTop: 16, minHeight: 52 }} accessibilityLabel={t('officials.svc.request.send_cta')} />
    </FormSheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FindOfficialsHub — organiser's official discovery experience
// ─────────────────────────────────────────────────────────────────────────────

export function FindOfficialsHub({ sports = [] }) {
  const { go } = useNav();
  const { toast } = useSession();
  const { wide } = useLayout();
  const [filters, setFilters] = useState({ sport: '', role: '', grade: '', event_type: '', verified_only: false, volunteer_only: false, max_fee: '', city: '' });
  const setFilter = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const [shortlisted, setShortlisted] = useState({});
  const [requesting, setRequesting] = useState(null);
  const [detail, setDetail] = useState(null);

  const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== '' && v !== false).map(([k, v]) => [k === 'max_fee' ? 'max_fee_minor' : k, k === 'max_fee' ? Math.round(Number(v) * 100) : v])).toString();
  const { data, loading, error, reload } = useLoad(`/official-services${params ? '?' + params : ''}`);
  const results = data?.results ?? [];

  const toggleShortlist = async (item) => {
    const was = shortlisted[item.id];
    setShortlisted((s) => ({ ...s, [item.id]: !was }));
    try {
      await api[was ? 'delete' : 'post'](`/marketplace/listings/${item.id}/shortlist`);
    } catch (e) {
      setShortlisted((s) => ({ ...s, [item.id]: was }));
      toast(explain(e));
    }
  };

  return (
    <Screen title={t('officials.svc.find.title')} subtitle={t('officials.svc.find.subtitle')}>
      {/* Filters */}
      <View style={{ gap: 8, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: c.paper, borderBottomWidth: 1, borderBottomColor: c.line }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {sports.length ? (
              <MenuField
                label={t('officials.svc.find.sport')}
                value={filters.sport}
                options={[{ value: '', label: t('officials.svc.find.all_sports') }, ...sports.map((s) => ({ value: s.slug, label: s.name }))]}
                onSelect={(v) => setFilter('sport', v)}
                compact
                accessibilityLabel={t('officials.svc.find.sport')}
              />
            ) : null}
            <MenuField
              label={t('officials.svc.find.role')}
              value={filters.role}
              options={[{ value: '', label: t('officials.svc.find.all_roles') }, ...ROLES]}
              onSelect={(v) => setFilter('role', v)}
              compact
              accessibilityLabel={t('officials.svc.find.role')}
            />
            <MenuField
              label={t('officials.svc.find.event_type')}
              value={filters.event_type}
              options={[{ value: '', label: t('officials.svc.find.all_events') }, ...EVENT_TYPES]}
              onSelect={(v) => setFilter('event_type', v)}
              compact
              accessibilityLabel={t('officials.svc.find.event_type')}
            />
            <Chip
              label={t('officials.svc.find.verified_only')}
              selected={filters.verified_only}
              onPress={() => setFilter('verified_only', !filters.verified_only)}
              accessibilityLabel={t('officials.svc.find.verified_only')}
            />
            <Chip
              label={t('officials.svc.find.volunteer_only')}
              selected={filters.volunteer_only}
              onPress={() => setFilter('volunteer_only', !filters.volunteer_only)}
              accessibilityLabel={t('officials.svc.find.volunteer_only')}
            />
          </View>
        </ScrollView>
      </View>

      {/* Results */}
      {loading ? <Loading /> : error ? <LoadError onRetry={reload} /> : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 12, gap: 10, paddingBottom: 32 }}
          numColumns={wide ? 2 : 1}
          key={wide ? 'wide' : 'narrow'}
          columnWrapperStyle={wide ? { gap: 10 } : undefined}
          renderItem={({ item }) => (
            <OfficialCard
              item={item}
              onRequest={(it) => setRequesting(it)}
              onDetail={(it) => setDetail(it)}
              shortlisted={!!shortlisted[item.id]}
              onShortlist={toggleShortlist}
            />
          )}
          ListEmptyComponent={<Empty emoji="🔍" title={t('officials.svc.find.empty')} sub={t('officials.svc.find.empty_sub')} />}
        />
      )}

      {/* Detail sheet */}
      {detail && (
        <OfficialServiceDetail
          listing={detail}
          onClose={() => setDetail(null)}
          onRequest={(it) => setRequesting(it)}
        />
      )}

      {/* Request sheet */}
      {requesting && (
        <OfficialRequestSheet
          official={requesting}
          visible={!!requesting}
          onClose={() => setRequesting(null)}
          sports={sports}
          onSent={(engagementId) => go('MarketplaceEngagement', { id: engagementId })}
        />
      )}
    </Screen>
  );
}
