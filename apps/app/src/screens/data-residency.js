import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { c, r } from '../theme';
import { t } from '../i18n';
import { useNav } from '../nav';
import { useSession } from '../session';
import { api } from '../api';

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
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('GET', '/data-residency/me').then(setData).finally(() => setLoading(false));
  }, []);

  if (loading) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}><ActivityIndicator color={c.pink} /></View>;

  const assignment = data?.assignment;
  const consents = data?.consents ?? [];
  const transfer = data?.active_transfer;
  const migrationAvailable = assignment && !transfer;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 14 }}>
      <Row style={{ marginBottom: 4 }}>
        <TouchableOpacity onPress={back} hitSlop={12} style={{ marginRight: 12 }}>
          <Text style={{ fontSize: 22, color: c.ink }}>←</Text>
        </TouchableOpacity>
        <Text style={{ fontSize: 17, fontWeight: '700', color: c.ink, flex: 1 }}>{t('residency.title')}</Text>
      </Row>

      {assignment ? (
        <View style={{ borderRadius: r.card, padding: 20, overflow: 'hidden',
          ...(Platform.OS === 'web' ? { background: 'linear-gradient(135deg,#8458B3,#494D5F)' } : { backgroundColor: c.violet }) }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.8)', textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 6 }}>{t('residency.current_region')}</Text>
          <Text style={{ fontSize: 22, fontWeight: '800', color: '#fff', marginBottom: 4 }}>{assignment.home_region}</Text>
          <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.72)', marginBottom: 12 }}>{assignment.jurisdiction} · {assignment.data_classification}</Text>
          <Row style={{ flexWrap: 'wrap', gap: 8 }}>
            <Chip label={`✓ ${t('residency.status.active')}`} bg="rgba(255,255,255,0.18)" color="#fff" />
            <Chip label={`Policy v${assignment.policy_version}`} bg="rgba(255,255,255,0.18)" color="#fff" />
            {assignment.transfer_basis
              ? <Chip label={t('residency.status.fallback')} bg="rgba(255,180,0,0.3)" color="#fff" />
              : <Chip label={t('residency.status.in_country')} bg="rgba(95,211,154,0.25)" color="#fff" />}
          </Row>
        </View>
      ) : (
        <Card><Text style={{ color: c.mute, fontSize: 13 }}>{t('residency.no_assignment')}</Text></Card>
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
            <Text style={{ fontSize: 11, color: c.mute, marginTop: 2 }}>{co.source_country} → {co.destination_region} · {new Date(co.decided_at).toLocaleDateString()}</Text>
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
    </ScrollView>
  );
}

// ── DataResidencyConsent: Singapore fallback consent screen ───────────────────
export function DataResidencyConsent({ route }) {
  const { back } = useNav();
  const country = route?.params?.country ?? '';
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const POLICY_HASH = 'a3f8c2d1';
  const POLICY_VERSION = 1;

  const agree = useCallback(async () => {
    setBusy(true);
    try {
      await api('POST', '/data-residency/consent/singapore', {
        source_country: country,
        policy_version: POLICY_VERSION,
        policy_text_hash: POLICY_HASH,
        data_categories: ['profile_identity', 'sport_records', 'device_session', 'payment_references'],
        purposes: ['platform_access', 'event_management', 'results_rankings', 'communications', 'support_safety'],
      });
      setDone(true);
    } finally { setBusy(false); }
  }, [country]);

  if (done) return (
    <View style={{ flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <Text style={{ fontSize: 48, marginBottom: 16 }}>🇸🇬</Text>
      <Text style={{ fontSize: 20, fontWeight: '800', color: c.ink, marginBottom: 8, textAlign: 'center' }}>{t('residency.consent_success_title')}</Text>
      <Text style={{ fontSize: 14, color: c.mute, textAlign: 'center', lineHeight: 22 }}>{t('residency.consent_success_body')}</Text>
      <TouchableOpacity onPress={back} style={{ marginTop: 24, backgroundColor: c.pink, borderRadius: r.pill, paddingHorizontal: 32, paddingVertical: 14 }}>
        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>{t('common.continue')}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 14 }}>
      <Row style={{ marginBottom: 4 }}>
        <TouchableOpacity onPress={back} hitSlop={12} style={{ marginRight: 12 }}>
          <Text style={{ fontSize: 22, color: c.ink }}>←</Text>
        </TouchableOpacity>
        <Text style={{ fontSize: 17, fontWeight: '700', color: c.ink, flex: 1 }}>{t('residency.fallback_title')}</Text>
      </Row>

      <View style={{ width: 56, height: 56, borderRadius: 16, backgroundColor: c.pinkSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 28 }}>🇸🇬</Text>
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
          { k: t('residency.policy_version_label'), v: `v${POLICY_VERSION} · 2026-11-08` },
          { k: t('residency.policy_hash_label'), v: `sha256:${POLICY_HASH}…` },
          { k: t('residency.policy_region_label'), v: 'ap-southeast-1' },
        ].map(({ k, v }) => (
          <Row key={k} style={{ justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 11, color: c.mute, fontWeight: '500' }}>{k}</Text>
            <Text style={{ fontSize: 11, color: c.ink, fontWeight: '600', fontFamily: Platform.OS === 'web' ? 'monospace' : undefined }}>{v}</Text>
          </Row>
        ))}
      </Card>

      <View style={{ backgroundColor: c.pinkSoft, borderRadius: 12, padding: 14, borderWidth: 1.5, borderColor: c.pink }}>
        <Text style={{ fontSize: 11, fontWeight: '700', color: c.pink, textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 6 }}>{t('residency.affirmation_label')}</Text>
        <Text style={{ fontSize: 12, color: c.ink, lineHeight: 20 }}>{t('residency.affirmation_body')}</Text>
      </View>

      <Btn label={`🇸🇬 ${t('residency.fallback_agree')}`} onPress={agree} disabled={busy} />
      <Btn label={`⏳ ${t('residency.fallback_waitlist')}`} onPress={back} variant="secondary" />
      <Btn label={t('residency.fallback_decline')} onPress={back} variant="ghost" />
      <Text style={{ fontSize: 11, color: c.mute, textAlign: 'center' }}>{t('residency.no_pretick')}</Text>
    </ScrollView>
  );
}

// ── DataResidencyMigration: request region migration ──────────────────────────
export function DataResidencyMigration() {
  const { back } = useNav();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api('GET', '/data-residency/me').then(setData);
  }, []);

  const submit = async () => {
    if (!data?.assignment) return;
    setBusy(true);
    try {
      await api('POST', '/data-residency/migration', { to_region: 'ap-south-1' });
      setDone(true);
    } finally { setBusy(false); }
  };

  if (!data) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}><ActivityIndicator color={c.pink} /></View>;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 14 }}>
      <Row style={{ marginBottom: 4 }}>
        <TouchableOpacity onPress={back} hitSlop={12} style={{ marginRight: 12 }}>
          <Text style={{ fontSize: 22, color: c.ink }}>←</Text>
        </TouchableOpacity>
        <Text style={{ fontSize: 17, fontWeight: '700', color: c.ink, flex: 1 }}>{t('residency.migration_title')}</Text>
      </Row>

      <Card>
        <Row style={{ gap: 10 }}>
          <View style={{ flex: 1, backgroundColor: c.bg, borderRadius: 12, padding: 12, borderWidth: 1.5, borderColor: c.line }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: c.mute, textTransform: 'uppercase', marginBottom: 4 }}>{t('residency.migration_from')}</Text>
            <Text style={{ fontSize: 20 }}>🇸🇬</Text>
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.ink }}>AWS Singapore</Text>
            <Text style={{ fontSize: 11, color: c.mute }}>ap-southeast-1</Text>
          </View>
          <Text style={{ fontSize: 20, color: c.pink }}>→</Text>
          <View style={{ flex: 1, backgroundColor: c.pinkSoft, borderRadius: 12, padding: 12, borderWidth: 1.5, borderColor: c.pink }}>
            <Text style={{ fontSize: 10, fontWeight: '700', color: c.pink, textTransform: 'uppercase', marginBottom: 4 }}>{t('residency.migration_to')}</Text>
            <Text style={{ fontSize: 20 }}>🇮🇳</Text>
            <Text style={{ fontSize: 13, fontWeight: '700', color: c.ink }}>AWS Mumbai</Text>
            <Text style={{ fontSize: 11, color: c.mute }}>ap-south-1</Text>
          </View>
        </Row>
      </Card>

      <Card>
        <SectionHead label={t('residency.migration_stages_title')} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {['requested','eligibility_review','owner_approval','inventory_frozen','destination_prepared','encrypted_copy','checksum_reconcile','dual_read','cutover_approval','destination_active','source_restricted','retention_erase','verified_complete'].map((s, i) => (
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
        <Btn label={t('residency.migration_submit')} onPress={submit} disabled={busy} />
      )}
      <Btn label={t('common.cancel')} onPress={back} variant="ghost" />
    </ScrollView>
  );
}

// ── DataResidencyAdmin: platform-admin region registry ────────────────────────
export function DataResidencyAdmin() {
  const { back } = useNav();
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('GET', '/data-residency/regions').then((d) => setCatalog(d.regions ?? [])).finally(() => setLoading(false));
  }, []);

  if (loading) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}><ActivityIndicator color={c.pink} /></View>;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 14 }}>
      <Row style={{ marginBottom: 4, gap: 12 }}>
        <TouchableOpacity onPress={back} hitSlop={12}>
          <Text style={{ fontSize: 22, color: c.ink }}>←</Text>
        </TouchableOpacity>
        <Text style={{ fontSize: 17, fontWeight: '700', color: c.ink, flex: 1 }}>{t('residency.admin.registry_title')}</Text>
        <Chip label="🔒 Admin" bg={c.red} color="#fff" />
      </Row>
      <Card>
        <SectionHead label={t('residency.admin.regions_heading')} />
        {catalog.map((reg) => (
          <Row key={reg.aws_region} style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line, gap: 10 }}>
            <Text style={{ fontSize: 20, width: 28 }}>🌍</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: c.ink }}>{reg.display_name}</Text>
              <Text style={{ fontSize: 11, color: c.mute }}>{reg.country_code} · {reg.aws_region}</Text>
            </View>
            <Chip label="Active" bg="#E0F5F1" color="#2F8F5F" />
          </Row>
        ))}
        {catalog.length === 0 && <Text style={{ fontSize: 13, color: c.mute }}>No active regions. Contact platform admin to activate.</Text>}
      </Card>
    </ScrollView>
  );
}
