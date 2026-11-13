import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Text, TouchableOpacity, View } from 'react-native';
import { Screen } from '../ui';
import { c, r } from '../theme';
import { t } from '../i18n';
import { useNav } from '../nav';
import { useSession } from '../session';
import { api } from '../api';
import { CountryPicker, countryName } from '../country-picker';
import { locale, deviceZone } from '../locale';

const TZ_COUNTRY_DR = { 'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Colombo': 'LK', 'Asia/Dubai': 'AE', 'Asia/Singapore': 'SG', 'Asia/Kuala_Lumpur': 'MY', 'Asia/Bangkok': 'TH', 'America/New_York': 'US', 'America/Los_Angeles': 'US', 'America/Chicago': 'US', 'America/Toronto': 'CA', 'Europe/London': 'GB', 'Australia/Sydney': 'AU' };
const inferCountry = () => { try { const reg = new Intl.Locale(locale).region; if (reg && /^[A-Z]{2}$/.test(reg)) return reg; } catch {} return TZ_COUNTRY_DR[deviceZone] ?? ''; };

// People are told the country their data lives in, never the hosting provider or its region code.
const REGION_COUNTRY = { 'ap-southeast-1': 'SG', 'ap-south-1': 'IN', 'us-east-1': 'US', 'ca-central-1': 'CA', 'me-central-1': 'AE' };
const regionCountry = (region) => REGION_COUNTRY[region] ?? '';
const regionLabel = (region, fallbackCountry) => countryName(regionCountry(region) || fallbackCountry) || t('residency.current_region');

// ── shared primitives ──────────────────────────────────────────────────────────
const Row = ({ children, style }) => <View style={[{ flexDirection: 'row', alignItems: 'center' }, style]}>{children}</View>;
const Chip = ({ label, color, bg, style }) => (
  <View style={[{ borderRadius: r.pill, paddingHorizontal: 10, paddingVertical: 3, backgroundColor: bg || c.pinkSoft }, style]}>
    <Text style={{ fontSize: 11, fontWeight: '700', color: color || c.pink }}>{label}</Text>
  </View>
);
const SectionHead = ({ label }) => (
  <Text style={{ fontSize: 11, fontWeight: '700', color: c.mute, letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 10 }}>{label}</Text>
);
const Card = ({ children, style }) => (
  <View style={[{ backgroundColor: c.paper, borderRadius: r.card, padding: 16 }, style]}>{children}</View>
);
const Btn = ({ label, onPress, variant = 'primary', disabled }) => {
  const bg = variant === 'primary' ? c.pink : 'transparent';
  const color = variant === 'primary' ? '#fff' : variant === 'secondary' ? c.ink : c.mute;
  const border = variant === 'secondary' ? { borderWidth: 1.5, borderColor: c.line } : {};
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} activeOpacity={0.75}
      style={[{ borderRadius: r.pill, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: bg, opacity: disabled ? 0.4 : 1 }, border]}>
      <Text style={{ fontSize: 15, fontWeight: '700', color }}>{label}</Text>
    </TouchableOpacity>
  );
};

// ── DataResidency: main settings screen ───────────────────────────────────────
export function DataResidency() {
  const { back, push } = useNav();
  const { refresh } = useSession();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pickCountry, setPickCountry] = useState('');
  const [preview, setPreview] = useState(null);
  const [savingCountry, setSavingCountry] = useState(false);

  useEffect(() => {
    api.get('/data-residency/me').then((d) => { setData(d); if (!d?.home_country) setPickCountry(inferCountry()); }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!pickCountry) { setPreview(null); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.get('/data-residency/preview', { country: pickCountry }).then((r) => { if (!cancelled) setPreview(r); }).catch(() => {});
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pickCountry]);

  const saveCountry = async () => {
    if (!pickCountry) return;
    setSavingCountry(true);
    try {
      await api.patch('/me/home-country', { home_country: pickCountry });
      await refresh().catch(() => {}); // the Home banner reads the session, so it must learn the country now
      const p = preview ?? await api.get('/data-residency/preview', { country: pickCountry });
      if (!p?.supported) { push('DataResidencyConsent', { country: pickCountry }); return; }
      const d = await api.get('/data-residency/me');
      setData(d);
    } catch (e) { /* show nothing, user can retry */ } finally { setSavingCountry(false); }
  };

  if (loading) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}><ActivityIndicator color={c.pink} /></View>;

  const assignment = data?.assignment;
  const consents = data?.consents ?? [];
  const transfer = data?.active_transfer;
  const migrationAvailable = assignment && !transfer;

  return (
    <Screen><View style={{ gap: 14 }}>
      {assignment ? (
        <View style={{ borderRadius: r.card, padding: 20, overflow: 'hidden',
          ...(Platform.OS === 'web' ? { background: 'linear-gradient(135deg,#8458B3,#494D5F)' } : { backgroundColor: c.violet }) }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.8)', textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 6 }}>{t('residency.current_region')}</Text>
          <Text style={{ fontSize: 22, fontWeight: '800', color: '#fff', marginBottom: 4 }}>{regionLabel(assignment.home_region, assignment.jurisdiction)}</Text>
          <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.72)', marginBottom: 12 }}>{[countryName(assignment.jurisdiction), assignment.data_classification].filter(Boolean).join(' · ')}</Text>
          <Row style={{ flexWrap: 'wrap', gap: 8 }}>
            <Chip label={`✓ ${t('residency.status.active')}`} bg="rgba(255,255,255,0.18)" color="#fff" />
            <Chip label={t('residency.policy_chip', { v: assignment.policy_version })} bg="rgba(255,255,255,0.18)" color="#fff" />
            {assignment.transfer_basis
              ? <Chip label={t('residency.status.fallback')} bg="rgba(255,180,0,0.3)" color="#fff" />
              : <Chip label={t('residency.status.in_country')} bg="rgba(95,211,154,0.25)" color="#fff" />}
          </Row>
        </View>
      ) : data?.home_country ? (
        <Card style={{ gap: 12, borderLeftWidth: 3, borderLeftColor: '#E8A000' }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: c.ink }}>{t('residency.no_assignment_title')}</Text>
          <Text style={{ fontSize: 13, color: c.mute, lineHeight: 20 }}>{t('residency.no_assignment_body')}</Text>
          <Btn label={t('residency.no_assignment_cta')} onPress={() => push('DataResidencyConsent', { country: data.home_country })} />
        </Card>
      ) : (
        <Card style={{ gap: 14 }}>
          <Text style={{ fontSize: 17, fontWeight: '800', color: c.ink }}>{t('residency.set_country_title')}</Text>
          <Text style={{ fontSize: 13, color: c.mute, lineHeight: 20 }}>{t('residency.set_country_body')}</Text>
          <CountryPicker label={t('residency.country_label')} value={pickCountry} onChange={setPickCountry} />
          {pickCountry && preview !== null ? (
            <View style={{ borderRadius: 10, padding: 12, backgroundColor: preview?.supported ? 'rgba(95,211,154,0.18)' : 'rgba(255,180,0,0.18)' }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: preview?.supported ? '#2d7a4f' : '#8a5c00' }}>{preview?.supported ? t('residency.supported_banner', { region: countryName(pickCountry) }) : t('residency.unsupported_banner', { country: countryName(pickCountry) })}</Text>
            </View>
          ) : pickCountry ? (
            <Text style={{ fontSize: 12, color: c.mute }}>{t('residency.preview_loading')}</Text>
          ) : null}
          <Btn label={t('residency.set_country_cta')} onPress={saveCountry} disabled={!pickCountry || savingCountry} />
          <TouchableOpacity onPress={back} style={{ alignItems: 'center', paddingVertical: 8 }}>
            <Text style={{ fontSize: 13, color: c.mute, fontWeight: '600' }}>{t('residency.set_country_skip')}</Text>
          </TouchableOpacity>
        </Card>
      )}

      <Row style={{ gap: 10 }}>
        {[
          { n: '4', label: t('residency.stat_categories') },
          { n: consents.length, label: t('residency.stat_consents') },
          { n: transfer ? '1' : '0', label: t('residency.stat_transfers') },
        ].map((s) => (
          <Card key={s.label} style={{ flex: 1, alignItems: 'center', paddingVertical: 12 }}>
            <Text style={{ fontSize: 22, fontWeight: '800', color: c.ink, marginBottom: 2 }}>{s.n}</Text>
            <Text style={{ fontSize: 11, color: c.mute, fontWeight: '500', textAlign: 'center' }}>{s.label}</Text>
          </Card>
        ))}
      </Row>

      <Card>
        <SectionHead label={t('residency.categories_title')} />
        {[
          { icon: '👤', name: t('residency.cat_profile'), sub: t('residency.cat_profile_sub'), badge: t('residency.badge_encrypted') },
          { icon: '⚽', name: t('residency.cat_sport'), sub: t('residency.cat_sport_sub'), badge: t('residency.badge_public_opt') },
          { icon: '📱', name: t('residency.cat_device'), sub: t('residency.cat_device_sub'), badge: t('residency.badge_auto_purge') },
          { icon: '💳', name: t('residency.cat_payment'), sub: t('residency.cat_payment_sub'), badge: t('residency.badge_finance') },
        ].map((cat) => (
          <Row key={cat.name} style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line, gap: 10 }}>
            <View style={{ width: 32, height: 32, borderRadius: 9, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 15 }}>{cat.icon}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: c.ink }}>{cat.name}</Text>
              <Text style={{ fontSize: 11, color: c.mute, marginTop: 1 }}>{cat.sub}</Text>
            </View>
            <Chip label={cat.badge} />
          </Row>
        ))}
      </Card>

      <Card>
        <SectionHead label={t('residency.consent_history')} />
        {consents.length === 0 ? (
          <Text style={{ fontSize: 13, color: c.mute }}>{t('residency.no_consents')}</Text>
        ) : consents.map((co, idx) => (
          <View key={co.id} style={{ paddingVertical: 10, borderBottomWidth: idx < consents.length - 1 ? 1 : 0, borderBottomColor: c.line }}>
            <Text style={{ fontSize: 13, fontWeight: '600', color: c.ink }}>{co.affirmative ? '✓ ' + t('residency.consent_granted') : '✗ ' + t('residency.consent_declined')}</Text>
            <Text style={{ fontSize: 11, color: c.mute, marginTop: 2 }}>{countryName(co.source_country)} → {regionLabel(co.destination_region)} · {new Date(co.decided_at).toLocaleDateString()}</Text>
            {co.revoked_at && <Text style={{ fontSize: 11, color: c.red, marginTop: 2 }}>{t('residency.consent_revoked')} {new Date(co.revoked_at).toLocaleDateString()}</Text>}
          </View>
        ))}
      </Card>

      <TouchableOpacity
        disabled={!migrationAvailable}
        onPress={() => push('DataResidencyMigration')}
        style={{ backgroundColor: c.paper, borderRadius: r.pill, paddingVertical: 14, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', opacity: migrationAvailable ? 1 : 0.4, borderWidth: 1.5, borderColor: c.line }}
        accessibilityRole="button" accessibilityLabel={t('residency.request_migration')}>
        <Row style={{ gap: 8 }}>
          <Text style={{ fontSize: 16 }}>🌍</Text>
          <Text style={{ fontSize: 14, fontWeight: '600', color: c.ink }}>{t('residency.request_migration')}</Text>
        </Row>
        <Text style={{ fontSize: 16, color: c.mute }}>→</Text>
      </TouchableOpacity>
      {!migrationAvailable && (
        <Text style={{ fontSize: 11, color: c.mute, textAlign: 'center', marginTop: -8 }}>{transfer ? t('residency.migration_in_progress') : t('residency.migration_unavailable')}</Text>
      )}
    </View></Screen>
  );
}

// ── DataResidencyConsent: Singapore fallback consent screen (two affirmative checkboxes) ──
export function DataResidencyConsent({ route }) {
  const { back, push } = useNav();
  const { refresh } = useSession();
  const country = route?.params?.country ?? '';
  const guardianId = route?.params?.guardian_id ?? null;
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [localCountry, setLocalCountry] = useState(country);
  const [policyInfo, setPolicyInfo] = useState(null);
  const [check1, setCheck1] = useState(false);
  const [check2, setCheck2] = useState(false);

  useEffect(() => {
    if (localCountry) api.get('/data-residency/preview', { country: localCountry }).then(setPolicyInfo).catch(() => {});
  }, [localCountry]);

  const canAgree = check1 && check2 && localCountry.length === 2 && !!policyInfo && !busy;

  const agree = useCallback(async () => {
    if (!canAgree) return;
    setBusy(true);
    try {
      await api.post('/data-residency/consent/singapore', {
        source_country: localCountry,
        policy_version: policyInfo.policy_version,
        policy_text_hash: policyInfo.policy_text_hash,
        data_categories: ['profile_identity', 'sport_records', 'device_session', 'payment_references'],
        purposes: ['platform_access', 'event_management', 'results_rankings', 'communications', 'support_safety'],
        ...(guardianId ? { guardian_id: guardianId } : {}),
      });
      await refresh().catch(() => {});
      setDone(true);
    } finally { setBusy(false); }
  }, [canAgree, localCountry, policyInfo, guardianId, refresh]);

  if (done) return (
    <View style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <Text style={{ fontSize: 48, marginBottom: 16 }}>📍</Text>
      <Text style={{ fontSize: 20, fontWeight: '800', color: c.ink, marginBottom: 8, textAlign: 'center' }}>{t('residency.consent_success_title')}</Text>
      <Text style={{ fontSize: 14, color: c.mute, textAlign: 'center', lineHeight: 22 }}>{t('residency.consent_success_body')}</Text>
      <TouchableOpacity onPress={back} style={{ marginTop: 24, backgroundColor: c.pink, borderRadius: r.pill, paddingHorizontal: 32, paddingVertical: 14 }}>
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>{t('common.done')}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <Screen><View style={{ gap: 14 }}>
      <View style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 28 }}>📍</Text>
      </View>

      <Text style={{ fontSize: 20, fontWeight: '800', color: c.ink }}>{t('residency.fallback_title')}</Text>
      <Text style={{ fontSize: 13, color: c.mute, lineHeight: 20 }}>{t('residency.fallback_body')}</Text>

      <View style={{ borderRadius: 12, padding: 12, borderWidth: 1.5, borderColor: c.line, flexDirection: 'row', gap: 10 }}>
        <Text style={{ fontSize: 18 }}>⚖️</Text>
        <Text style={{ fontSize: 12, color: c.ink, lineHeight: 18, flex: 1 }}>{t('residency.fallback_jurisdiction')}</Text>
      </View>

      <SectionHead label={t('residency.categories_title')} />
      {[
        { icon: '👤', name: t('residency.cat_profile'), sub: t('residency.cat_profile_sub') },
        { icon: '⚽', name: t('residency.cat_sport'), sub: t('residency.cat_sport_sub') },
        { icon: '📱', name: t('residency.cat_device'), sub: t('residency.cat_device_sub') },
        { icon: '💳', name: t('residency.cat_payment'), sub: t('residency.cat_payment_sub') },
      ].map((cat) => (
        <Card key={cat.name} style={{ flexDirection: 'row', gap: 10, padding: 10 }}>
          <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 14 }}>{cat.icon}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 12, fontWeight: '600', color: c.ink }}>{cat.name}</Text>
            <Text style={{ fontSize: 11, color: c.mute }}>{cat.sub}</Text>
          </View>
        </Card>
      ))}

      <Card style={{ gap: 4 }}>
        {[
          { k: t('residency.policy_version_label'), v: policyInfo ? `v${policyInfo.policy_version} · 2026-11-08` : '…' },
          { k: t('residency.policy_hash_label'), v: policyInfo ? `sha256:${policyInfo.policy_text_hash}…` : '…' },
          { k: t('residency.policy_region_label'), v: countryName('SG') },
        ].map(({ k, v }) => (
          <Row key={k} style={{ justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 11, color: c.mute, fontWeight: '500' }}>{k}</Text>
            <Text style={{ fontSize: 11, color: c.ink, fontWeight: '600', fontFamily: Platform.OS === 'web' ? 'monospace' : undefined }}>{v}</Text>
          </Row>
        ))}
      </Card>

      {/* Two separate affirmative checkboxes — both required; neither pre-ticked */}
      {[
        { checked: check1, onPress: () => setCheck1((v) => !v), label: t('residency.consent_check1') },
        { checked: check2, onPress: () => setCheck2((v) => !v), label: t('residency.consent_check2') },
      ].map(({ checked, onPress, label }, idx) => (
        <TouchableOpacity key={idx} onPress={onPress} activeOpacity={0.8}
          style={{ flexDirection: 'row', gap: 12, padding: 14, borderRadius: 12,
            borderWidth: 1.5, borderColor: checked ? c.pink : c.line,
            backgroundColor: checked ? c.pinkSoft : c.paper }}
          accessibilityRole="checkbox" accessibilityState={{ checked }}>
          <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2,
            borderColor: checked ? c.pink : c.line,
            backgroundColor: checked ? c.pink : 'transparent',
            alignItems: 'center', justifyContent: 'center', marginTop: 1, flexShrink: 0 }}>
            {checked && <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>✓</Text>}
          </View>
          <Text style={{ flex: 1, fontSize: 12, color: c.ink, lineHeight: 20 }}>{label}</Text>
        </TouchableOpacity>
      ))}

      {!localCountry && (
        <CountryPicker value={localCountry} onChange={setLocalCountry} label={t('residency.country_label')} />
      )}
      <Btn label={t('residency.fallback_agree')} onPress={agree} disabled={!canAgree} />
      <Btn label={t('residency.fallback_waitlist')} onPress={() => push('DataResidencyDeclined', { country: localCountry })} variant="secondary" />
      <Btn label={t('residency.fallback_decline')} onPress={() => push('DataResidencyDeclined', { country: localCountry })} variant="ghost" />
      <Text style={{ fontSize: 11, color: c.mute, textAlign: 'center' }}>{t('residency.no_pretick')}</Text>
    </View></Screen>
  );
}

// ── DataResidencyDeclined: safe refusal path — alternatives when consent not given ──
export function DataResidencyDeclined({ route }) {
  const { back, push } = useNav();
  const country = route?.params?.country ?? '';
  const [waitlistDone, setWaitlistDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const joinWaitlist = async () => {
    if (!country || busy) return;
    setBusy(true);
    try {
      await api.post('/data-residency/waitlist', { country });
      setWaitlistDone(true);
    } catch { /* non-fatal */ } finally { setBusy(false); }
  };

  return (
    <Screen><View style={{ gap: 14 }}>
      <View style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: c.violetSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 28 }}>🚫</Text>
      </View>
      <Text style={{ fontSize: 20, fontWeight: '800', color: c.ink }}>{t('residency.declined_title')}</Text>
      <Text style={{ fontSize: 13, color: c.mute, lineHeight: 20 }}>{t('residency.declined_body')}</Text>

      <Card>
        {[
          { icon: '👁️', title: t('residency.declined_browse'), sub: t('residency.declined_browse_sub'), onPress: back, color: c.cyan },
          { icon: '📋', title: t('residency.declined_waitlist'), sub: waitlistDone ? t('residency.migration_notify_sent') : t('residency.declined_waitlist_sub'), onPress: joinWaitlist, color: c.lime, done: waitlistDone },
          { icon: '🔁', title: t('residency.declined_review'), sub: t('residency.declined_review_sub'), onPress: () => push('DataResidencyConsent', { country }), color: c.sun },
        ].map(({ icon, title, sub, onPress, color, done }) => (
          <TouchableOpacity key={title} onPress={onPress} disabled={done} activeOpacity={0.75}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.line, opacity: done ? 0.6 : 1 }}>
            <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 17 }}>{icon}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.ink }}>{title}</Text>
              <Text style={{ fontSize: 11, color: c.mute, marginTop: 1 }}>{sub}</Text>
            </View>
            <Text style={{ fontSize: 16, color }}>{done ? '✓' : '›'}</Text>
          </TouchableOpacity>
        ))}
        <View style={{ paddingTop: 10 }}>
          <Text style={{ fontSize: 11, color: c.mute, lineHeight: 18 }}>{t('residency.declined_contact')}</Text>
        </View>
      </Card>
    </View></Screen>
  );
}

// ── DataResidencyGuardian: guardian consent for a minor's account ──────────────
export function DataResidencyGuardian({ route }) {
  const { back } = useNav();
  const { refresh } = useSession();
  const childId = route?.params?.child_id ?? '';
  const childName = route?.params?.child_name ?? '';
  const childAge = route?.params?.child_age ?? '';
  const country = route?.params?.country ?? '';
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [policyInfo, setPolicyInfo] = useState(null);
  const [verified, setVerified] = useState(false);
  const [check1, setCheck1] = useState(false);
  const [check2, setCheck2] = useState(false);
  const [check3, setCheck3] = useState(false);

  useEffect(() => {
    if (country) api.get('/data-residency/preview', { country }).then(setPolicyInfo).catch(() => {});
  }, [country]);

  const canAgree = verified && check1 && check2 && check3 && !!policyInfo && !busy;

  const agree = useCallback(async () => {
    if (!canAgree) return;
    setBusy(true);
    try {
      await api.post('/data-residency/consent/singapore', {
        source_country: country,
        policy_version: policyInfo.policy_version,
        policy_text_hash: policyInfo.policy_text_hash,
        data_categories: ['profile_identity', 'sport_records', 'device_session'],
        purposes: ['platform_access', 'event_management', 'results_rankings', 'support_safety'],
        guardian_id: null, // server uses calling user's id as guardian from auth context
      });
      await refresh().catch(() => {});
      setDone(true);
    } finally { setBusy(false); }
  }, [canAgree, country, policyInfo, refresh]);

  if (done) return (
    <View style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <Text style={{ fontSize: 48, marginBottom: 16 }}>✅</Text>
      <Text style={{ fontSize: 20, fontWeight: '800', color: c.ink, marginBottom: 8, textAlign: 'center' }}>{t('residency.consent_success_title')}</Text>
      <Text style={{ fontSize: 14, color: c.mute, textAlign: 'center', lineHeight: 22 }}>{t('residency.consent_success_body')}</Text>
      <TouchableOpacity onPress={back} style={{ marginTop: 24, backgroundColor: c.pink, borderRadius: r.pill, paddingHorizontal: 32, paddingVertical: 14 }}>
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>{t('common.done')}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <Screen><View style={{ gap: 14 }}>
      <Row style={{ gap: 10 }}>
        <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: c.cyanSoft, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 24 }}>🧒</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: c.ink }}>{t('residency.guardian_title')}</Text>
          <Text style={{ fontSize: 12, color: c.mute }}>{t('residency.guardian_body')}</Text>
        </View>
      </Row>

      {/* Child details card */}
      <Card style={{ backgroundColor: c.cyanSoft, borderWidth: 0 }}>
        <Text style={{ fontSize: 11, fontWeight: '700', color: c.mute, textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 6 }}>{t('residency.guardian_child_label')}</Text>
        <Row style={{ gap: 10 }}>
          <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: c.paper, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 17 }}>🧒</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: c.ink }}>{childName || '—'}</Text>
            <Text style={{ fontSize: 12, color: c.mute }}>{childAge ? `Age ${childAge}` : ''} · {countryName(country) || country} · Under 16 — heightened protection</Text>
          </View>
        </Row>
      </Card>

      {/* Guardian identity verification */}
      <Card style={{ gap: 10 }}>
        <Text style={{ fontSize: 13, fontWeight: '700', color: c.red }}>{t('residency.guardian_verify_note')}</Text>
        <Text style={{ fontSize: 12, color: c.mute, lineHeight: 18 }}>{t('residency.guardian_verify_note')}</Text>
        <Btn label={verified ? '✓ Identity verified' : t('residency.guardian_verify_cta')} onPress={() => setVerified(true)} variant={verified ? 'secondary' : 'primary'} disabled={verified} />
      </Card>

      {/* Health note */}
      <View style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1.5, borderColor: c.sun, backgroundColor: c.sunSoft }}>
        <Text style={{ fontSize: 16 }}>⚠️</Text>
        <Text style={{ fontSize: 12, color: c.ink, flex: 1, lineHeight: 18 }}>{t('residency.guardian_health_note')}</Text>
      </View>

      {/* Three separate guardian checkboxes */}
      {[
        { checked: check1, onPress: () => setCheck1((v) => !v), label: t('residency.guardian_check1') },
        { checked: check2, onPress: () => setCheck2((v) => !v), label: t('residency.guardian_check2') },
        { checked: check3, onPress: () => setCheck3((v) => !v), label: t('residency.guardian_check3') },
      ].map(({ checked, onPress, label }, idx) => (
        <TouchableOpacity key={idx} onPress={onPress} disabled={!verified} activeOpacity={0.8}
          style={{ flexDirection: 'row', gap: 12, padding: 14, borderRadius: 12,
            borderWidth: 1.5, borderColor: checked ? c.pink : c.line,
            backgroundColor: checked ? c.pinkSoft : c.paper, opacity: verified ? 1 : 0.4 }}
          accessibilityRole="checkbox" accessibilityState={{ checked }}>
          <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2,
            borderColor: checked ? c.pink : c.line,
            backgroundColor: checked ? c.pink : 'transparent',
            alignItems: 'center', justifyContent: 'center', marginTop: 1, flexShrink: 0 }}>
            {checked && <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>✓</Text>}
          </View>
          <Text style={{ flex: 1, fontSize: 12, color: c.ink, lineHeight: 20 }}>{label}</Text>
        </TouchableOpacity>
      ))}

      <Btn label={t('residency.guardian_agree')} onPress={agree} disabled={!canAgree} />
      <Btn label={t('common.cancel')} onPress={back} variant="ghost" />
    </View></Screen>
  );
}

// ── DataResidencyMigration: request region migration (dynamic destination) ────
const MIGRATION_STAGES = ['requested','eligibility_review','owner_approval','inventory_frozen','destination_prepared','encrypted_copy','checksum_reconcile','dual_read','cutover_approval','destination_active','source_restricted','retention_erase','verified_complete'];

export function DataResidencyMigration() {
  const { back } = useNav();
  const [data, setData] = useState(null);
  const [regions, setRegions] = useState([]);
  const [toRegion, setToRegion] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [waitlistBusy, setWaitlistBusy] = useState(false);
  const [waitlistDone, setWaitlistDone] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/data-residency/me'),
      api.get('/data-residency/regions'),
    ]).then(([me, reg]) => {
      setData(me);
      const available = (reg.regions ?? []).filter((r) => r.aws_region !== me?.assignment?.home_region);
      setRegions(available);
      if (available.length === 1) setToRegion(available[0].aws_region);
    });
  }, []);

  const submit = async () => {
    if (!data?.assignment || !toRegion || busy) return;
    setBusy(true);
    try {
      await api.post('/data-residency/migration', { to_region: toRegion });
      setDone(true);
    } finally { setBusy(false); }
  };

  const joinWaitlist = async () => {
    if (waitlistBusy) return;
    setWaitlistBusy(true);
    try { await api.post('/data-residency/waitlist', { country: data?.home_country ?? '' }); setWaitlistDone(true); }
    catch { /* non-fatal */ } finally { setWaitlistBusy(false); }
  };

  if (!data) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}><ActivityIndicator color={c.pink} /></View>;
  const from = data.assignment?.home_region;
  const activeTransfer = data.active_transfer;

  if (activeTransfer) {
    const stageIdx = MIGRATION_STAGES.indexOf(activeTransfer.transfer_state);
    return (
      <Screen><View style={{ gap: 14 }}>
        <Card style={{ backgroundColor: c.cyanSoft, borderWidth: 0 }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: c.ink }}>{t('residency.migration_in_progress')}</Text>
          <Text style={{ fontSize: 12, color: c.mute, marginTop: 4 }}>{regionLabel(activeTransfer.from_region)} → {regionLabel(activeTransfer.to_region)}</Text>
        </Card>
        <Card>
          <SectionHead label={t('residency.migration_stages_title')} />
          {MIGRATION_STAGES.map((s, i) => (
            <Row key={s} style={{ paddingVertical: 8, borderBottomWidth: i < MIGRATION_STAGES.length - 1 ? 1 : 0, borderBottomColor: c.line, gap: 10 }}>
              <View style={{ width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
                backgroundColor: i < stageIdx ? c.limeSoft : i === stageIdx ? c.pink : c.bg,
                borderWidth: 1.5, borderColor: i < stageIdx ? c.lime : i === stageIdx ? c.pink : c.line }}>
                <Text style={{ fontSize: 10, fontWeight: '800', color: i < stageIdx ? c.lime : i === stageIdx ? '#fff' : c.mute }}>{i < stageIdx ? '✓' : i + 1}</Text>
              </View>
              <Text style={{ flex: 1, fontSize: 12, fontWeight: i === stageIdx ? '700' : '400', color: i === stageIdx ? c.ink : c.mute }}>{s.replace(/_/g, ' ')}</Text>
              {i === stageIdx && <Text style={{ fontSize: 11, color: c.pink, fontWeight: '700' }}>← current</Text>}
            </Row>
          ))}
        </Card>
        <Btn label={t('common.back')} onPress={back} variant="secondary" />
      </View></Screen>
    );
  }

  return (
    <Screen><View style={{ gap: 14 }}>
      <Card>
        <Row style={{ gap: 10 }}>
          <View style={{ flex: 1, backgroundColor: c.bg, borderRadius: 12, padding: 12, borderWidth: 1.5, borderColor: c.line }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: c.mute, textTransform: 'uppercase', marginBottom: 4 }}>{t('residency.migration_from')}</Text>
            <Text style={{ fontSize: 20 }}>📍</Text>
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.ink }}>{regionLabel(from)}</Text>
          </View>
          <Text style={{ fontSize: 20, color: c.pink }}>→</Text>
          <View style={{ flex: 1, backgroundColor: regions.length ? c.pinkSoft : c.bg, borderRadius: 12, padding: 12, borderWidth: 1.5, borderColor: regions.length ? c.pink : c.line }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: regions.length ? c.pink : c.mute, textTransform: 'uppercase', marginBottom: 4 }}>{t('residency.migration_to')}</Text>
            <Text style={{ fontSize: 20 }}>📍</Text>
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.ink }}>{toRegion ? regionLabel(toRegion) : '—'}</Text>
          </View>
        </Row>
      </Card>

      {regions.length === 0 ? (
        <Card style={{ gap: 10 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: c.ink }}>{t('residency.migration_no_regions')}</Text>
          {waitlistDone ? (
            <View style={{ borderRadius: 12, padding: 12, backgroundColor: c.limeSoft, borderWidth: 1.5, borderColor: c.lime }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.lime }}>✓ {t('residency.migration_notify_sent')}</Text>
            </View>
          ) : (
            <Btn label={t('residency.migration_notify_cta')} onPress={joinWaitlist} disabled={waitlistBusy} variant="secondary" />
          )}
        </Card>
      ) : (
        <>
          <Card>
            <SectionHead label={t('residency.migration_pick_region')} />
            {regions.map((reg) => (
              <TouchableOpacity key={reg.aws_region} onPress={() => setToRegion(reg.aws_region)} activeOpacity={0.75}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12,
                  borderBottomWidth: 1, borderBottomColor: c.line }}>
                <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2,
                  borderColor: toRegion === reg.aws_region ? c.pink : c.line,
                  backgroundColor: toRegion === reg.aws_region ? c.pink : 'transparent',
                  alignItems: 'center', justifyContent: 'center' }}>
                  {toRegion === reg.aws_region && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' }} />}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: c.ink }}>{reg.display_name}</Text>
                  <Text style={{ fontSize: 11, color: c.mute }}>{reg.country_code} · {reg.aws_region}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </Card>

          <Card>
            <SectionHead label={t('residency.migration_stages_title')} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {MIGRATION_STAGES.map((s, i) => (
                <View key={s} style={{ borderRadius: r.pill, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1.5, borderColor: i === 0 ? c.pink : c.line, backgroundColor: i === 0 ? c.pinkSoft : c.bg }}>
                  <Text style={{ fontSize: 10, fontWeight: '700', color: i === 0 ? c.pink : c.mute }}>{i + 1}. {s}</Text>
                </View>
              ))}
            </View>
          </Card>

          <View style={{ borderRadius: 12, padding: 12, flexDirection: 'row', gap: 10, borderWidth: 1.5, borderColor: c.line }}>
            <Text style={{ fontSize: 16 }}>⚠️</Text>
            <Text style={{ fontSize: 12, color: c.ink, lineHeight: 18, flex: 1 }}>{t('residency.migration_warning')}</Text>
          </View>

          {done ? (
            <View style={{ backgroundColor: c.pinkSoft, borderRadius: 12, padding: 16, alignItems: 'center' }}>
              <Text style={{ fontSize: 20, fontWeight: '800', color: c.pink, marginBottom: 4 }}>✓ {t('residency.migration_submitted')}</Text>
              <Text style={{ fontSize: 12, color: c.mute, textAlign: 'center' }}>{t('residency.migration_submitted_body')}</Text>
            </View>
          ) : (
            <Btn label={t('residency.migration_submit')} onPress={submit} disabled={!toRegion || busy} />
          )}
        </>
      )}
      <Btn label={t('common.cancel')} onPress={back} variant="ghost" />
    </View></Screen>
  );
}

// ── DataResidencyAdmin: platform-admin region registry with activate/suspend ──
export function DataResidencyAdmin() {
  const { toast } = useSession();
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // region id being actioned

  const load = useCallback(() => {
    setLoading(true);
    api.get('/data-residency/admin/regions').then((d) => setCatalog(d.regions ?? [])).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const activate = async (reg) => {
    setBusy(reg.id);
    try {
      await api.post(`/data-residency/admin/regions/${reg.id}/activate`, { policy_version: 1 });
      toast(t('residency.admin.activated'));
      load();
    } catch (e) { toast('' + e.message); } finally { setBusy(null); }
  };

  const suspend = async (reg) => {
    setBusy(reg.id);
    try {
      await api.post(`/data-residency/admin/regions/${reg.id}/suspend`);
      toast(t('residency.admin.suspended'));
      load();
    } catch (e) { toast('' + e.message); } finally { setBusy(null); }
  };

  if (loading) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}><ActivityIndicator color={c.pink} /></View>;

  return (
    <Screen><View style={{ gap: 14 }}>
      <Row><Chip label={t('residency.admin.badge')} bg={c.red} color="#fff" /></Row>
      <Card>
        <SectionHead label={t('residency.admin.all_regions')} />
        {catalog.map((reg) => {
          const active = reg.is_provisioned && reg.is_healthy && reg.is_policy_approved;
          return (
            <View key={reg.id} style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: c.line, gap: 8 }}>
              <Row style={{ gap: 10 }}>
                <Text style={{ fontSize: 20, width: 28 }}>📍</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: c.ink }}>{countryName(reg.country_code) || reg.country_code}</Text>
                  <Text style={{ fontSize: 11, color: c.mute }}>{reg.aws_region} · {reg.display_name}</Text>
                </View>
                <Chip
                  label={active ? t('residency.status.active') : reg.is_provisioned ? t('residency.status.provisioning') : t('residency.status.planned')}
                  bg={active ? c.limeSoft : c.sunSoft}
                  color={active ? c.lime : c.sun}
                />
              </Row>
              <Row style={{ gap: 8, justifyContent: 'flex-end' }}>
                {!active && (
                  <TouchableOpacity onPress={() => activate(reg)} disabled={busy === reg.id} activeOpacity={0.75}
                    style={{ borderRadius: r.pill, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: c.limeSoft, borderWidth: 1.5, borderColor: c.lime }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: c.lime }}>{busy === reg.id ? '…' : t('residency.admin.activate_btn')}</Text>
                  </TouchableOpacity>
                )}
                {active && (
                  <TouchableOpacity onPress={() => suspend(reg)} disabled={busy === reg.id} activeOpacity={0.75}
                    style={{ borderRadius: r.pill, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: c.redSoft, borderWidth: 1.5, borderColor: c.red }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: c.red }}>{busy === reg.id ? '…' : t('residency.admin.suspend_btn')}</Text>
                  </TouchableOpacity>
                )}
              </Row>
              {reg.notes && <Text style={{ fontSize: 11, color: c.mute }}>{reg.notes}</Text>}
            </View>
          );
        })}
        {catalog.length === 0 && <Text style={{ fontSize: 13, color: c.mute }}>{t('residency.admin.none')}</Text>}
      </Card>
    </View></Screen>
  );
}

// ── OrgDataResidency: organisation storage disclosure for org admins ───────────
export function OrgDataResidency({ route }) {
  const { back, push } = useNav();
  const orgId = route?.params?.org_id ?? '';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (orgId) api.get(`/data-residency/org/${orgId}`).then(setData).finally(() => setLoading(false));
  }, [orgId]);

  if (loading) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}><ActivityIndicator color={c.pink} /></View>;

  const assignment = data?.assignment;
  const summary = data?.member_summary ?? {};
  const org = data?.org ?? {};

  return (
    <Screen><View style={{ gap: 14 }}>
      <Text style={{ fontSize: 20, fontWeight: '800', color: c.ink }}>{t('residency.org.title')}</Text>
      <Text style={{ fontSize: 13, color: c.mute, lineHeight: 20 }}>{t('residency.org.body')}</Text>

      {/* Org region summary */}
      {assignment ? (
        <Card style={{ backgroundColor: c.limeSoft, borderWidth: 0 }}>
          <Row style={{ gap: 10, marginBottom: 8 }}>
            <Text style={{ fontSize: 24 }}>🏢</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: c.ink }}>{org.name || '—'}</Text>
              <Text style={{ fontSize: 12, color: c.mute }}>{countryName(org.country) || org.country}</Text>
            </View>
            <Chip label={t('residency.status.active')} bg={c.lime} color="#fff" />
          </Row>
          <Row style={{ gap: 10 }}>
            <Text style={{ fontSize: 12, color: c.mute, flex: 1 }}>{t('residency.current_region')}</Text>
            <Text style={{ fontSize: 12, fontWeight: '700', color: c.ink }}>{regionLabel(assignment.home_region, assignment.jurisdiction)}</Text>
          </Row>
          <Row style={{ gap: 10, marginTop: 4 }}>
            <Text style={{ fontSize: 12, color: c.mute, flex: 1 }}>{t('residency.policy_version_label')}</Text>
            <Text style={{ fontSize: 12, fontWeight: '700', color: c.ink }}>v{assignment.policy_version}</Text>
          </Row>
        </Card>
      ) : (
        <Card style={{ borderLeftWidth: 3, borderLeftColor: c.sun }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: c.ink }}>{t('residency.no_assignment_title')}</Text>
          <Text style={{ fontSize: 13, color: c.mute, marginTop: 4 }}>{t('residency.no_assignment_body')}</Text>
        </Card>
      )}

      {/* Member consent summary */}
      <Row style={{ gap: 10 }}>
        <Card style={{ flex: 1, alignItems: 'center', paddingVertical: 12 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: c.lime }}>{summary.consented ?? '—'}</Text>
          <Text style={{ fontSize: 11, color: c.mute, fontWeight: '500', textAlign: 'center' }}>{t('residency.org.members_consented')}</Text>
        </Card>
        <Card style={{ flex: 1, alignItems: 'center', paddingVertical: 12 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: c.sun }}>{summary.pending ?? '—'}</Text>
          <Text style={{ fontSize: 11, color: c.mute, fontWeight: '500', textAlign: 'center' }}>{t('residency.org.members_pending')}</Text>
        </Card>
        <Card style={{ flex: 1, alignItems: 'center', paddingVertical: 12 }}>
          <Text style={{ fontSize: 22, fontWeight: '800', color: c.ink }}>{summary.youth_total ?? '—'}</Text>
          <Text style={{ fontSize: 11, color: c.mute, fontWeight: '500', textAlign: 'center' }}>{t('residency.org.youth_label')}</Text>
        </Card>
      </Row>

      {/* Data categories */}
      <Card>
        <SectionHead label={t('residency.categories_title')} />
        {[
          { icon: '👤', name: t('residency.org.members_consented'), tag: regionLabel(assignment?.home_region, assignment?.jurisdiction) },
          { icon: '🧒', name: t('residency.org.youth_label'), tag: t('residency.org.guardian_consent') },
          { icon: '🩺', name: t('residency.org.health_label'), tag: t('residency.badge_encrypted') },
          { icon: '💳', name: t('residency.org.finance_label'), tag: t('residency.badge_finance') },
          { icon: '📄', name: t('residency.org.docs_label'), tag: regionLabel(assignment?.home_region, assignment?.jurisdiction) },
        ].map((row) => (
          <Row key={row.name} style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line, gap: 10 }}>
            <View style={{ width: 32, height: 32, borderRadius: 9, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 15 }}>{row.icon}</Text>
            </View>
            <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: c.ink }}>{row.name}</Text>
            <Chip label={row.tag || '—'} />
          </Row>
        ))}
      </Card>

      <Btn label={t('residency.org.view_compliance')} onPress={() => push('DataResidency')} variant="secondary" />
    </View></Screen>
  );
}

// ── ResidencyBanner: shown on the Home tab when home_country is not set ───────
export function ResidencyBanner() {
  const { user } = useSession();
  const { push } = useNav();
  if (user?.home_country) return null;
  return (
    <View style={{ marginHorizontal: 0, marginTop: 12, borderRadius: r.card, padding: 16, backgroundColor: '#FFF8E6', borderWidth: 1.5, borderColor: '#F5C842' }}>
      <Row style={{ gap: 10, marginBottom: 6 }}>
        <Text style={{ fontSize: 20 }}>📍</Text>
        <Text style={{ fontSize: 14, fontWeight: '800', color: '#7A5000', flex: 1 }}>{t('residency.banner_title')}</Text>
      </Row>
      <Text style={{ fontSize: 12, color: '#7A5000', lineHeight: 18, marginBottom: 12 }}>{t('residency.banner_body')}</Text>
      <TouchableOpacity onPress={() => push('DataResidency')} activeOpacity={0.78}
        style={{ borderRadius: r.pill, paddingVertical: 12, alignItems: 'center', backgroundColor: '#F5C842' }}
        accessibilityRole="button" accessibilityLabel={t('residency.set_country_cta')}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: '#3D2800' }}>{t('residency.set_country_cta')}</Text>
      </TouchableOpacity>
    </View>
  );
}
