// 5-step wizard: link an externally created event into GotMyGame's managed workspace.
// Source → Verify → Preview → Capabilities → Review → Create Managed Workspace.
import React, { useState } from 'react';
import { FlatList, Linking, Platform, ScrollView, Switch, TouchableOpacity, View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { useNav } from '../nav';
import { Btn, Card, ErrorBox, Field, Loading, Sheet, T } from '../ui';
import { DateField } from '../pickers';
import { SportsMulti } from '../sportpicker';
import { t } from '../i18n';
import { c, r } from '../theme';

const STEPS = [
  'event.ext.step_source',
  'event.ext.step_verify',
  'event.ext.step_preview',
  'event.ext.step_capabilities',
  'event.ext.step_review',
];

const CAPABILITY_GROUPS = [
  {
    key: 'operations',
    label: 'event.ext.cap_group_operations',
    caps: ['staff_assignments', 'suppliers', 'budget', 'readiness_board'],
  },
  {
    key: 'competition',
    label: 'event.ext.cap_group_competition',
    caps: ['scoring', 'official_results', 'fixtures'],
  },
  {
    key: 'venue',
    label: 'event.ext.cap_group_venue',
    caps: ['venue_booking', 'floor_maps'],
  },
  {
    key: 'commercial',
    label: 'event.ext.cap_group_commercial',
    caps: ['sponsorship', 'ticketing'],
  },
];

const PROVIDER_ICON = {
  event_source_ics_feed: '📅',
  event_source_federation_xml: '🏅',
  event_source_bookmyshow_in: '🎟️',
  event_source_manual: '📋',
};
const providerIcon = (key) => PROVIDER_ICON[key] ?? '🔗';

export function EventExternalLink({ visible, onClose, onCreated, initialEventId }) {
  const { toast } = useSession();
  const nav = useNav();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [authorityConfirmed, setAuthorityConfirmed] = useState(false);
  const [enabledCaps, setEnabledCaps] = useState({
    staff_assignments: true, suppliers: true, budget: true, readiness_board: true,
    scoring: false, official_results: false, fixtures: true,
    venue_booking: true, floor_maps: false,
    sponsorship: true, ticketing: false,
  });
  const [f, setF] = useState({
    provider_key: '',
    external_url: '',
    event_id: initialEventId ?? '',
    source_title: '', source_sport_slug: '', source_starts_on: '', source_ends_on: '',
    source_venue_name: '', source_organiser_name: '',
    link_mode: 'reference_only', authority_type: 'organiser_attested',
  });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const providers = useLoad(
    () => (visible ? api.get('/integrations/catalogue', { category: 'event_source' }) : Promise.resolve([])),
    [visible]
  );

  const canAdvance = [
    () => !!f.provider_key,
    () => authorityConfirmed && !!previewData,
    () => !!(f.source_title.trim()),
    () => Object.values(enabledCaps).some(Boolean),
    () => true,
  ][step]?.() ?? false;

  const preview = async () => {
    if (!f.provider_key || !f.external_url.trim()) return;
    setBusy(true);
    try {
      const res = await api.post('/events/external/preview', {
        provider_key: f.provider_key,
        external_url: f.external_url.trim(),
      });
      setPreviewData(res);
      if (res.source_title) set('source_title', res.source_title);
      if (res.source_sport_slug) set('source_sport_slug', res.source_sport_slug);
      if (res.source_starts_on) set('source_starts_on', res.source_starts_on);
      if (res.source_ends_on) set('source_ends_on', res.source_ends_on);
      if (res.source_venue_name) set('source_venue_name', res.source_venue_name);
      if (res.source_organiser_name) set('source_organiser_name', res.source_organiser_name);
      if (res.link_mode) set('link_mode', res.link_mode);
      setStep(1);
    } catch (e) { toast('' + e.message); } finally { setBusy(false); }
  };

  const submit = async () => {
    setBusy(true);
    try {
      const managed = Object.entries(enabledCaps).filter(([, v]) => v).map(([k]) => k);
      const body = {
        ...f,
        sync_policy: { managed_capabilities: managed },
        authority_type: 'organiser_attested',
        ...(f.external_url.trim() ? {} : {}),
      };
      if (!f.event_id) {
        const ev = await api.post('/events', {
          name: f.source_title.trim() || 'External Event',
          kind: 'tournament',
          sports: f.source_sport_slug ? [f.source_sport_slug] : [],
          starts_on: f.source_starts_on || undefined,
          ends_on: f.source_ends_on || undefined,
          city: f.source_venue_name || '',
        });
        body.event_id = ev.id;
      }
      const link = await api.post('/events/external/link', body);
      toast(t('event.ext.linked_ok'));
      onClose?.();
      onCreated?.(link);
      if (link.event_id) nav.push('EventCommand', { id: link.event_id });
    } catch (e) { toast('' + e.message); } finally { setBusy(false); }
  };

  const selectedProvider = (providers.data ?? []).find((p) => p.key === f.provider_key);

  return (
    <Sheet visible={visible} onClose={onClose} title={t('event.ext.wizard_title')}>
      {/* Step progress rail */}
      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 20 }}>
        {STEPS.map((sk, i) => (
          <View key={sk} style={{ flex: 1, gap: 4 }}>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: i <= step ? c.pink : c.line }} />
            <T size={10} weight={i === step ? '800' : '500'} color={i === step ? c.ink : c.mute} numberOfLines={1}>
              {t(sk)}
            </T>
          </View>
        ))}
      </View>

      {/* Step 0 — Source */}
      {step === 0 && (
        <View style={{ gap: 14 }}>
          <T size={15} weight="700" color={c.ink}>{t('event.ext.source_title')}</T>
          <T size={13} color={c.mute}>{t('event.ext.source_hint')}</T>
          {providers.loading ? <Loading /> : providers.error ? <ErrorBox error={providers.error} onRetry={providers.reload} /> : (
            <FlatList
              data={providers.data ?? []}
              keyExtractor={(p) => p.key}
              style={{ maxHeight: 240 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  onPress={() => set('provider_key', item.key)}
                  accessibilityLabel={item.name}
                  style={[styles.providerRow, { backgroundColor: f.provider_key === item.key ? c.pinkSoft : c.paper, borderColor: f.provider_key === item.key ? c.pink : c.line }]}>
                  <T size={20}>{providerIcon(item.key)}</T>
                  <View style={{ flex: 1 }}>
                    <T size={13} weight="700" color={c.ink}>{item.name}</T>
                    {item.disclaimer ? <T size={11} color={c.mute} numberOfLines={2}>{item.disclaimer}</T> : null}
                  </View>
                  {f.provider_key === item.key && <T size={16} color={c.pink}>✓</T>}
                </TouchableOpacity>
              )}
            />
          )}
          {f.provider_key && (
            <Field
              label={t('event.ext.url_label')}
              value={f.external_url}
              onChangeText={(x) => set('external_url', x)}
              placeholder={t('event.ext.url_placeholder')}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          )}
        </View>
      )}

      {/* Step 1 — Verify */}
      {step === 1 && previewData && (
        <View style={{ gap: 14 }}>
          <T size={15} weight="700" color={c.ink}>{t('event.ext.verify_title')}</T>
          <View style={[styles.trustBox, { backgroundColor: c.pinkSoft, borderColor: c.pink }]}>
            <T size={13} weight="700" color={c.pink}>{t(`event.ext.trust_${previewData.trust_level ?? 'reference_only'}`)}</T>
            <T size={12} color={c.mute}>{t(`event.ext.link_mode_${previewData.link_mode ?? 'reference_only'}`)}</T>
          </View>
          {(previewData.warnings ?? []).map((w, i) => (
            <View key={i} style={[styles.warnBox, { backgroundColor: c.sunSoft }]}>
              <T size={12} color={c.sun}>⚠️ {w}</T>
            </View>
          ))}
          {previewData.preview_fields && Object.entries(previewData.preview_fields).map(([k, v]) => (
            v ? <View key={k} style={styles.previewRow}>
              <T size={12} color={c.mute} style={{ flex: 1 }}>{k.replace(/_/g, ' ')}</T>
              <T size={12} weight="600" color={c.ink} style={{ flex: 2 }}>{v}</T>
            </View> : null
          ))}
          <TouchableOpacity
            onPress={() => setAuthorityConfirmed((p) => !p)}
            accessibilityLabel={t('event.ext.authority_confirm')}
            style={styles.checkRow}>
            <View style={[styles.checkbox, { backgroundColor: authorityConfirmed ? c.pink : c.paper, borderColor: authorityConfirmed ? c.pink : c.line }]}>
              {authorityConfirmed && <T size={12} color="#fff">✓</T>}
            </View>
            <T size={13} color={c.ink} style={{ flex: 1 }}>{t('event.ext.authority_confirm')}</T>
          </TouchableOpacity>
        </View>
      )}

      {/* Step 2 — Preview / field editing */}
      {step === 2 && (
        <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>
          <View style={{ gap: 12 }}>
            <T size={15} weight="700" color={c.ink}>{t('event.ext.preview_title')}</T>
            <FieldWithBadge label={t('event.ext.field_title')} badge={f.link_mode === 'reference_only' ? 'Manual' : 'External'}>
              <Field label="" value={f.source_title} onChangeText={(x) => set('source_title', x)} placeholder={t('event.ext.field_title_ph')} />
            </FieldWithBadge>
            <View style={{ gap: 6 }}>
              <T size={13} weight="600" color={c.ink}>{t('event.ext.field_dates')}</T>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <DateField label={t('event.ext.field_starts')} value={f.source_starts_on} onChange={(x) => set('source_starts_on', x)} style={{ flex: 1 }} />
                <DateField label={t('event.ext.field_ends')} value={f.source_ends_on} onChange={(x) => set('source_ends_on', x)} style={{ flex: 1 }} />
              </View>
            </View>
            <FieldWithBadge label={t('event.ext.field_venue')} badge="External">
              <Field label="" value={f.source_venue_name} onChangeText={(x) => set('source_venue_name', x)} placeholder={t('event.ext.field_venue_ph')} />
            </FieldWithBadge>
            <FieldWithBadge label={t('event.ext.field_organiser')} badge="External">
              <Field label="" value={f.source_organiser_name} onChangeText={(x) => set('source_organiser_name', x)} placeholder={t('event.ext.field_organiser_ph')} />
            </FieldWithBadge>
          </View>
        </ScrollView>
      )}

      {/* Step 3 — Capabilities */}
      {step === 3 && (
        <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
          <View style={{ gap: 16 }}>
            <T size={15} weight="700" color={c.ink}>{t('event.ext.caps_title')}</T>
            <T size={13} color={c.mute}>{t('event.ext.caps_hint')}</T>
            {CAPABILITY_GROUPS.map((group) => (
              <View key={group.key} style={{ gap: 8 }}>
                <T size={13} weight="700" color={c.ink}>{t(group.label)}</T>
                {group.caps.map((cap) => {
                  const allowed = !previewData || (previewData.available_capabilities ?? []).includes(cap) || group.key === 'operations';
                  return (
                    <TouchableOpacity
                      key={cap}
                      onPress={() => allowed && setEnabledCaps((p) => ({ ...p, [cap]: !p[cap] }))}
                      accessibilityLabel={cap.replace(/_/g, ' ')}
                      style={[styles.capRow, { opacity: allowed ? 1 : 0.4 }]}>
                      <Switch
                        value={enabledCaps[cap] ?? false}
                        onValueChange={(v) => allowed && setEnabledCaps((p) => ({ ...p, [cap]: v }))}
                        trackColor={{ true: c.pink }}
                        disabled={!allowed}
                      />
                      <View style={{ flex: 1 }}>
                        <T size={13} weight="600" color={c.ink}>{cap.replace(/_/g, ' ')}</T>
                        {!allowed && <T size={11} color={c.mute}>{t('event.ext.cap_gated')}</T>}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
          </View>
        </ScrollView>
      )}

      {/* Step 4 — Review */}
      {step === 4 && (
        <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
          <View style={{ gap: 14 }}>
            <T size={15} weight="700" color={c.ink}>{t('event.ext.review_title')}</T>
            <Card pad={12}>
              <T size={16}>{providerIcon(f.provider_key)}</T>
              <T size={14} weight="700" color={c.ink}>{f.source_title || t('event.ext.untitled_event')}</T>
              {f.source_starts_on ? <T size={12} color={c.mute}>{f.source_starts_on}{f.source_ends_on !== f.source_starts_on ? ` → ${f.source_ends_on}` : ''}</T> : null}
              {f.source_venue_name ? <T size={12} color={c.mute}>{f.source_venue_name}</T> : null}
              {f.source_organiser_name ? <T size={12} color={c.mute}>{t('event.ext.review_organiser')} {f.source_organiser_name}</T> : null}
            </Card>
            <View style={{ gap: 6 }}>
              <T size={13} weight="700" color={c.ink}>{t('event.ext.review_caps')}</T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {Object.entries(enabledCaps).filter(([, v]) => v).map(([k]) => (
                  <View key={k} style={[styles.capChip, { backgroundColor: c.pinkSoft }]}>
                    <T size={11} weight="600" color={c.pink}>{k.replace(/_/g, ' ')}</T>
                  </View>
                ))}
              </View>
            </View>
            <View style={{ gap: 6 }}>
              <T size={13} weight="700" color={c.ink}>{t('event.ext.review_authority')}</T>
              <T size={12} color={c.mute}>{t(`event.ext.link_mode_${f.link_mode}`)}</T>
            </View>
            {f.link_mode === 'reference_only' && (
              <View style={[styles.disclaimerBox, { backgroundColor: c.sunSoft }]}>
                <T size={12} color={c.sun}>{t('event.ext.reference_disclaimer')}</T>
              </View>
            )}
            <Btn title={t('event.ext.create_workspace')} onPress={submit} loading={busy} />
          </View>
        </ScrollView>
      )}

      {/* Nav buttons */}
      {step < 4 && (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
          {step > 0 && (
            <Btn title={t('common.back')} color={c.paper} onPress={() => setStep((p) => p - 1)} style={{ flex: 1 }} />
          )}
          {step === 0 ? (
            <Btn
              title={t('event.ext.action_preview')}
              onPress={preview}
              loading={busy}
              disabled={!f.provider_key || !f.external_url.trim()}
              style={{ flex: 1 }}
            />
          ) : (
            <Btn
              title={t('common.next')}
              onPress={() => setStep((p) => p + 1)}
              disabled={!canAdvance}
              style={{ flex: 1 }}
            />
          )}
        </View>
      )}
    </Sheet>
  );
}

function FieldWithBadge({ label, badge, children }) {
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <T size={13} weight="600" color={c.ink}>{label}</T>
        <View style={[styles.badgeChip, { backgroundColor: badge === 'External' ? c.cyanSoft : c.line }]}>
          <T size={10} weight="700" color={badge === 'External' ? c.cyan : c.mute}>[{badge}]</T>
        </View>
      </View>
      {children}
    </View>
  );
}

import { StyleSheet } from 'react-native';
const styles = StyleSheet.create({
  providerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1.5, marginBottom: 8, minHeight: 56 },
  trustBox: { borderRadius: 10, padding: 12, borderWidth: 1, gap: 4 },
  warnBox: { borderRadius: 8, padding: 10 },
  previewRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#ccc' },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 44 },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  capRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingVertical: 4 },
  capChip: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  badgeChip: { borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2 },
  disclaimerBox: { borderRadius: 8, padding: 10 },
});
